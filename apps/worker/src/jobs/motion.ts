import { PLATFORM, keepMotionSegments, withScope } from "@topcam/db";
import { alarmActiveAt, sendMail, type AlarmSchedule } from "@topcam/shared";
import type { WorkerContext } from "../context.js";
import { loadSmtp } from "./monitor.js";

/**
 * Movimento no worker:
 *  - keepMotion: gravação só com movimento — mantém os segmentos que encostam num movimento.
 *  - processAlarms: alarme — decide, para cada movimento novo, se notifica (horário,
 *    intervalo mínimo) e envia aos usuários do cliente com acesso à câmera.
 *    Hoje por e-mail; a notificação push entra com o app (Fase 9), na mesma decisão.
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
  failed: number;
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
  deps: { send?: typeof sendMail; now?: number } = {},
): Promise<AlarmReport> {
  const now = deps.now ?? Date.now();
  const send = deps.send ?? sendMail;
  const out: AlarmReport = { evaluated: 0, notified: 0, suppressed: 0, emails: 0, failed: 0 };

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
    const toSend: Array<PendingMotion & { recipients: Array<{ id: string; email: string }> }> = [];
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
        if (!recipients.length) status = "no_recipients";
        else if (!m.alarm_email) status = "no_channel";
        else {
          status = "sending";
          toSend.push({ ...m, recipients });
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

  // 2. Envia fora da transação (o SMTP pode demorar).
  const s = await loadSmtp(ctx);
  const panel = ctx.env.PANEL_URL ? ctx.env.PANEL_URL.replace(/\/$/, "") : "";
  for (const m of decided) {
    out.notified++;
    const what = KIND_PT[m.kind] ?? KIND_PT.motion!;
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
    let final = "sent";
    const results: Array<{ user: string; ok: boolean; error?: string }> = [];
    if (!s.host) {
      final = "failed";
      for (const r of m.recipients)
        results.push({
          user: r.id,
          ok: false,
          error: "E-mail (SMTP) não configurado em Integrações",
        });
    } else {
      for (const r of m.recipients) {
        try {
          await send(s, ctx.encKey, { to: [r.email], subject, text });
          results.push({ user: r.id, ok: true });
          out.emails++;
        } catch (err) {
          results.push({ user: r.id, ok: false, error: (err as Error).message.slice(0, 300) });
          out.failed++;
        }
      }
      if (results.every((r) => !r.ok)) final = "failed";
    }
    await withScope(ctx.pool, PLATFORM, async (c) => {
      for (const r of results)
        await c.query(
          `INSERT INTO alarm_notifications (tenant_id, camera_id, motion_event_id, user_id, channel, status, error)
           VALUES ($1, $2, $3, $4, 'email', $5, $6)`,
          [m.tenant_id, m.camera_id, m.id, r.user, r.ok ? "sent" : "failed", r.error ?? null],
        );
      await c.query("UPDATE motion_events SET alarm_status = $2 WHERE id = $1", [m.id, final]);
    });
  }
  if (out.failed) ctx.log.warn(out, "alarme: falha ao enviar e-mail");
  return out;
}
