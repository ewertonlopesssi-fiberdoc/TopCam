import { PLATFORM, keepMotionSegments, withScope } from "@topcam/db";
import {
  alarmActiveAt,
  deadTokenError,
  pushReceipts,
  sendMail,
  sendPush,
  type AlarmSchedule,
  type PushMessage,
} from "@topcam/shared";
import type { WorkerContext } from "../context.js";
import { loadSmtp } from "./monitor.js";

/**
 * Movimento no worker:
 *  - keepMotion: gravação só com movimento — mantém os segmentos que encostam num movimento.
 *  - processAlarms: alarme — decide, para cada movimento novo, se notifica (horário,
 *    intervalo mínimo) e envia aos usuários do cliente com acesso à câmera: e-mail (se ligado
 *    na câmera) e push nos celulares com o app logado e as notificações ligadas.
 *  - checkPushReceipts: confere depois se o Google/Apple aceitou cada push e desliga os
 *    tokens de celulares que não têm mais o app.
 */

export async function keepMotion(ctx: WorkerContext): Promise<number> {
  return withScope(ctx.pool, PLATFORM, (c) => keepMotionSegments(c));
}

/** Movimentos mais velhos que isto não notificam (ex.: worker parado por horas). */
export const ALARM_MAX_AGE_MS = 10 * 60_000;

interface PendingMotion {
  id: string;
  tenant_id: string;
  camera_id: string;
  kind: string;
  started_at: Date;
  code: string;
  camera_name: string;
  tenant_name: string;
  location_name: string;
  alarm_enabled: boolean;
  alarm_schedule: AlarmSchedule;
  alarm_cooldown_s: number;
  alarm_email: boolean;
  alarm_last_notified_at: Date | null;
}

export interface AlarmReport {
  evaluated: number;
  notified: number;
  suppressed: number;
  emails: number;
  pushes: number;
  failed: number;
}

interface Recipient {
  id: string;
  email: string;
}
interface Device {
  id: string;
  token: string;
  user_id: string;
  can_playback: boolean;
}

const KIND_PT: Record<string, string> = {
  human: "Pessoa detectada",
  audio: "Som detectado",
  motion: "Movimento detectado",
};

const fmt = (d: Date) =>
  d.toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    dateStyle: "short",
    timeStyle: "medium",
  });

export async function processAlarms(
  ctx: WorkerContext,
  deps: { send?: typeof sendMail; push?: typeof sendPush; now?: number } = {},
): Promise<AlarmReport> {
  const now = deps.now ?? Date.now();
  const send = deps.send ?? sendMail;
  const push = deps.push ?? sendPush;
  const out: AlarmReport = {
    evaluated: 0,
    notified: 0,
    suppressed: 0,
    emails: 0,
    pushes: 0,
    failed: 0,
  };

  // 1. Decide (numa transação, com trava por câmera) e marca o movimento.
  const decided = await withScope(ctx.pool, PLATFORM, async (c) => {
    const rows = (
      await c.query<PendingMotion>(
        `SELECT m.id::text, m.tenant_id, m.camera_id, m.kind, m.started_at,
                cam.code, cam.name AS camera_name, t.name AS tenant_name, l.name AS location_name,
                cam.alarm_enabled, cam.alarm_schedule, cam.alarm_cooldown_s, cam.alarm_email,
                cam.alarm_last_notified_at
           FROM motion_events m
           JOIN cameras cam ON cam.id = m.camera_id
           JOIN tenants t ON t.id = m.tenant_id
           JOIN locations l ON l.id = cam.location_id
          WHERE m.alarm_status IS NULL
          ORDER BY m.id
          LIMIT 100
          FOR UPDATE OF m, cam SKIP LOCKED`,
      )
    ).rows;
    const toSend: Array<PendingMotion & { recipients: Recipient[]; devices: Device[] }> = [];
    for (const m of rows) {
      out.evaluated++;
      let status: string;
      if (!m.alarm_enabled) status = "disabled";
      else if (now - m.started_at.getTime() > ALARM_MAX_AGE_MS) status = "expired";
      else if (!alarmActiveAt(m.alarm_schedule, m.started_at)) status = "suppressed_schedule";
      else if (
        m.alarm_last_notified_at &&
        m.started_at.getTime() - m.alarm_last_notified_at.getTime() < m.alarm_cooldown_s * 1000
      )
        status = "suppressed_cooldown";
      else {
        const recipients = (
          await c.query<{ id: string; email: string }>(
            `SELECT u.id, u.email::text
               FROM users u JOIN roles r ON r.id = u.role_id
              WHERE u.tenant_id = $1 AND u.status = 'active' AND u.deleted_at IS NULL
                AND (r.key = 'tenant_admin' OR EXISTS (
                      SELECT 1 FROM user_camera_permissions p
                       WHERE p.user_id = u.id AND p.camera_id = $2 AND p.can_live))
              ORDER BY u.email LIMIT 50`,
            [m.tenant_id, m.camera_id],
          )
        ).rows;
        // Celulares com o app logado (sessão ativa) e as notificações ligadas.
        const devices = recipients.length
          ? (
              await c.query<Device>(
                `SELECT d.id::text, d.token, d.user_id::text,
                        (r.key = 'tenant_admin' OR coalesce(p.can_playback, false)) AS can_playback
                   FROM push_devices d
                   JOIN users u ON u.id = d.user_id
                   JOIN roles r ON r.id = u.role_id
                   JOIN sessions s ON s.id = d.session_id
                                  AND s.revoked_at IS NULL AND s.expires_at > now()
                   LEFT JOIN user_camera_permissions p ON p.user_id = u.id AND p.camera_id = $2
                  WHERE d.enabled AND d.user_id = ANY($1::uuid[])
                  ORDER BY d.created_at LIMIT 200`,
                [recipients.map((r) => r.id), m.camera_id],
              )
            ).rows
          : [];
        if (!recipients.length) status = "no_recipients";
        else if (!m.alarm_email && !devices.length) status = "no_channel";
        else {
          status = "sending";
          toSend.push({ ...m, recipients: m.alarm_email ? recipients : [], devices });
        }
        if (status !== "no_recipients")
          await c.query("UPDATE cameras SET alarm_last_notified_at = $2 WHERE id = $1", [
            m.camera_id,
            m.started_at,
          ]);
      }
      if (status.startsWith("suppressed") || status === "expired" || status === "disabled")
        out.suppressed++;
      await c.query("UPDATE motion_events SET alarm_status = $2, alarm_at = now() WHERE id = $1", [
        m.id,
        status,
      ]);
    }
    return toSend;
  });
  if (!decided.length) return out;

  // 2. Envia fora da transação (o SMTP e o serviço de push podem demorar).
  const s = await loadSmtp(ctx);
  const panel = ctx.env.PANEL_URL ? ctx.env.PANEL_URL.replace(/\/$/, "") : "";
  const pushOpts = { url: ctx.env.EXPO_PUSH_URL, accessToken: ctx.env.EXPO_ACCESS_TOKEN };
  for (const m of decided) {
    out.notified++;
    const what = KIND_PT[m.kind] ?? KIND_PT.motion!;
    const results: Array<{
      user: string;
      channel: "email" | "push";
      ok: boolean;
      error?: string;
      device?: string;
      ticket?: string;
    }> = [];

    // E-mail
    if (m.recipients.length) {
      const subject = `[TopCam] ${what}: ${m.camera_name} (${m.location_name})`;
      const text = [
        `${what} em ${m.camera_name} — ${m.location_name} (${m.tenant_name}).`,
        `Horário: ${fmt(m.started_at)}`,
        "",
        panel
          ? `Ver a gravação: ${panel}/gravacoes?camera=${m.camera_id}&t=${m.started_at.getTime()}`
          : "",
        "",
        "Você recebe este aviso porque o alarme desta câmera está ligado no TopCam.",
        "— TopCam (mensagem automática)",
      ].join("\n");
      if (!s.host) {
        for (const r of m.recipients)
          results.push({
            user: r.id,
            channel: "email",
            ok: false,
            error: "E-mail (SMTP) não configurado em Integrações",
          });
      } else {
        for (const r of m.recipients) {
          try {
            await send(s, ctx.encKey, { to: [r.email], subject, text });
            results.push({ user: r.id, channel: "email", ok: true });
            out.emails++;
          } catch (err) {
            results.push({
              user: r.id,
              channel: "email",
              ok: false,
              error: (err as Error).message.slice(0, 300),
            });
            out.failed++;
          }
        }
      }
    }

    // Push: um por celular. Tocar abre a gravação no horário (ou o ao vivo, sem permissão).
    if (m.devices.length) {
      const msgs: PushMessage[] = m.devices.map((d) => ({
        to: d.token,
        title: `${what}: ${m.camera_name}`,
        body: `${m.location_name} · ${fmt(m.started_at)}`,
        sound: "default",
        priority: "high",
        channelId: "alarmes",
        ttl: 3600,
        data: {
          type: "motion",
          eventId: m.id,
          cameraId: m.camera_id,
          cameraName: m.camera_name,
          t: m.started_at.getTime(),
          playback: d.can_playback,
        },
      }));
      const tickets = await push(msgs, pushOpts);
      const dead: string[] = [];
      m.devices.forEach((d, i) => {
        const t = tickets[i] ?? { status: "error" as const, message: "sem resposta" };
        if (t.status === "ok") out.pushes++;
        else {
          out.failed++;
          if (deadTokenError(t.error)) dead.push(d.id);
        }
        results.push({
          user: d.user_id,
          channel: "push",
          ok: t.status === "ok",
          error: t.status === "ok" ? undefined : `${t.error ?? ""} ${t.message ?? ""}`.trim(),
          device: d.id,
          ticket: t.id,
        });
      });
      await withScope(ctx.pool, PLATFORM, async (c) => {
        await c.query(
          `UPDATE push_devices SET last_sent_at = now(), last_error = NULL
            WHERE id = ANY($1::uuid[])`,
          [results.filter((r) => r.channel === "push" && r.ok).map((r) => r.device)],
        );
        if (dead.length)
          await c.query(
            `UPDATE push_devices SET enabled = false, disabled_reason = 'DeviceNotRegistered',
                    updated_at = now() WHERE id = ANY($1::uuid[])`,
            [dead],
          );
      });
    }

    const final = results.some((r) => r.ok) ? "sent" : "failed";
    await withScope(ctx.pool, PLATFORM, async (c) => {
      for (const r of results)
        await c.query(
          `INSERT INTO alarm_notifications
             (tenant_id, camera_id, motion_event_id, user_id, channel, status, error, push_device_id, push_ticket)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            m.tenant_id,
            m.camera_id,
            m.id,
            r.user,
            r.channel,
            r.ok ? "sent" : "failed",
            r.error ?? null,
            r.device ?? null,
            r.ticket ?? null,
          ],
        );
      await c.query("UPDATE motion_events SET alarm_status = $2 WHERE id = $1", [m.id, final]);
    });
  }
  if (out.failed) ctx.log.warn(out, "alarme: falha ao enviar e-mail ou push");
  return out;
}

/**
 * Recibos do push (15 min a 24 h depois do envio). Push recusado pelo Google/Apple vira
 * "failed" com o motivo; celular sem o app (DeviceNotRegistered) tem o token desligado.
 */
export async function checkPushReceipts(
  ctx: WorkerContext,
  deps: { receipts?: typeof pushReceipts } = {},
): Promise<{ checked: number; failed: number; disabled: number }> {
  const get = deps.receipts ?? pushReceipts;
  const out = { checked: 0, failed: 0, disabled: 0 };
  const rows = await withScope(ctx.pool, PLATFORM, async (c) => {
    // Velhos demais: a Expo não guarda o recibo; encerra sem conferir.
    await c.query(
      `UPDATE alarm_notifications SET receipt_checked_at = now()
        WHERE push_ticket IS NOT NULL AND receipt_checked_at IS NULL
          AND created_at < now() - interval '24 hours'`,
    );
    return (
      await c.query<{ id: string; push_ticket: string; push_device_id: string | null }>(
        `SELECT id::text, push_ticket, push_device_id::text FROM alarm_notifications
          WHERE push_ticket IS NOT NULL AND receipt_checked_at IS NULL
            AND created_at < now() - interval '15 minutes'
          ORDER BY created_at LIMIT 1000`,
      )
    ).rows;
  });
  if (!rows.length) return out;
  const receipts = await get(
    rows.map((r) => r.push_ticket),
    { url: ctx.env.EXPO_PUSH_URL, accessToken: ctx.env.EXPO_ACCESS_TOKEN },
  );
  await withScope(ctx.pool, PLATFORM, async (c) => {
    for (const r of rows) {
      const rc = receipts[r.push_ticket];
      if (!rc) continue; // ainda não saiu: confere na próxima rodada
      out.checked++;
      if (rc.status === "ok") {
        await c.query("UPDATE alarm_notifications SET receipt_checked_at = now() WHERE id = $1", [
          r.id,
        ]);
        continue;
      }
      out.failed++;
      const why = `${rc.error ?? ""} ${rc.message ?? ""}`.trim().slice(0, 300);
      await c.query(
        `UPDATE alarm_notifications SET receipt_checked_at = now(), status = 'failed', error = $2
          WHERE id = $1`,
        [r.id, why],
      );
      if (r.push_device_id) {
        await c.query("UPDATE push_devices SET last_error = $2 WHERE id = $1", [
          r.push_device_id,
          why,
        ]);
        if (deadTokenError(rc.error)) {
          const u = await c.query(
            `UPDATE push_devices SET enabled = false, disabled_reason = 'DeviceNotRegistered',
                    updated_at = now() WHERE id = $1 AND enabled`,
            [r.push_device_id],
          );
          out.disabled += u.rowCount ?? 0;
        }
      }
    }
  });
  return out;
}
