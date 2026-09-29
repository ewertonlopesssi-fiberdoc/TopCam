import { PLATFORM, getSetting, openAlert, raiseAlert, resolveAlert, withScope } from "@topcam/db";
import { SEVERITY_RANK, SMTP_DEFAULTS, sendMail, type SmtpSettings } from "@topcam/shared";
import type { WorkerContext } from "../context.js";

/**
 * Monitoramento (Fase 7), no worker:
 *
 *  checkCameraAlerts   a cada 10 s: câmera ativa em "offline"/"erro" → alerta
 *                      "câmera sem sinal"; câmera que deveria gravar e não confirma
 *                      segmento há RECORDING_STALL_S → alerta "câmera sem gravar".
 *                      Os alertas se fecham sozinhos quando a situação volta ao normal.
 *  accumulateHourly    a cada 10 s: soma segundos observados / no ar / gravando por
 *                      câmera e hora (relatório de disponibilidade).
 *  sampleStatus        a cada 5 min: câmeras por estado (por cliente e total) e tráfego
 *                      recebido pelo servidor de mídia (dashboard, 7 dias).
 *  notifyAlerts        a cada 15 s: e-mail dos alertas novos (ou que pioraram) acima da
 *                      gravidade mínima e, se ligado, dos resolvidos. Muitos de uma vez
 *                      viram um resumo único. Falha de envio: nova tentativa em 5 min.
 */

const ONLINE = ["recebendo", "validando", "ao_vivo", "gravando"];

// ------------------------------------------------------------------ alertas de câmera
export async function checkCameraAlerts(
  ctx: WorkerContext,
): Promise<{ opened: number; resolved: number }> {
  let opened = 0;
  let resolved = 0;
  await withScope(ctx.pool, PLATFORM, async (c) => {
    const global =
      (
        await c.query<{ value: unknown }>(
          "SELECT value FROM system_settings WHERE key = 'recording.globally_enabled'",
        )
      ).rows[0]?.value === true;
    const { rows } = await c.query<{
      id: string;
      tenant_id: string;
      code: string;
      name: string;
      tenant_name: string;
      status: string;
      active: boolean;
      since: Date;
      should_record: boolean;
      stale: boolean;
    }>(
      `SELECT c.id, c.tenant_id, c.code, c.name, t.name AS tenant_name, c.status,
              (c.enabled AND c.deleted_at IS NULL AND t.status = 'active' AND t.deleted_at IS NULL) AS active,
              c.status_changed_at AS since,
              (c.recording_enabled AND $1::boolean AND coalesce(s.recording_blocked, false) = false) AS should_record,
              (coalesce(c.last_durable_segment_at, 'epoch') < now() - make_interval(secs => $2)
                 AND c.status_changed_at < now() - make_interval(secs => $2)) AS stale
         FROM cameras c
         JOIN tenants t ON t.id = c.tenant_id
         LEFT JOIN storage_nodes s ON s.id = c.storage_node_id`,
      [global, ctx.env.RECORDING_STALL_S],
    );
    for (const r of rows) {
      const label = `${r.code} · ${r.name} (${r.tenant_name})`;
      const offKey = `camera_offline:${r.id}`;
      const recKey = `recording_stalled:${r.id}`;
      const down = r.active && (r.status === "offline" || r.status === "erro");
      if (down) {
        if (!(await openAlert(c, offKey))) {
          await raiseAlert(c, {
            dedupKey: offKey,
            rule: "camera_offline",
            severity: "error",
            title:
              r.status === "erro" ? `${label}: erro na transmissão` : `${label}: câmera sem sinal`,
            details: { status: r.status, since: r.since.toISOString(), code: r.code },
            tenantId: r.tenant_id,
            cameraId: r.id,
          });
          opened++;
        }
      } else if (await resolveAlert(c, offKey)) resolved++;

      const stalled =
        r.active &&
        r.should_record &&
        r.stale &&
        ONLINE.includes(r.status) &&
        r.status !== "gravando";
      if (stalled) {
        if (!(await openAlert(c, recKey))) {
          await raiseAlert(c, {
            dedupKey: recKey,
            rule: "recording_stalled",
            severity: "error",
            title: `${label}: ao vivo, mas sem gravar`,
            details: { stall_seconds: ctx.env.RECORDING_STALL_S, code: r.code },
            tenantId: r.tenant_id,
            cameraId: r.id,
          });
          opened++;
        }
      } else if (!stalled && (r.status === "gravando" || !r.should_record || !r.active || down)) {
        if (await resolveAlert(c, recKey)) resolved++;
      }
    }
  });
  return { opened, resolved };
}

// ------------------------------------------------------------------ disponibilidade por hora
export interface MonitorState {
  lastHourly: number | null;
  lastBytes: { at: number; bytes: number } | null;
  mailBackoffUntil: number;
}
export const newMonitorState = (): MonitorState => ({
  lastHourly: null,
  lastBytes: null,
  mailBackoffUntil: 0,
});

export async function accumulateHourly(
  ctx: WorkerContext,
  state: MonitorState,
  now = Date.now(),
  intervalS = 60,
) {
  // Worker parado por muito tempo não conta como "observado": no máximo 2 min por ciclo.
  const dt = state.lastHourly
    ? Math.min(
        Math.max(120, intervalS * 3),
        Math.max(1, Math.round((now - state.lastHourly) / 1000)),
      )
    : intervalS;
  state.lastHourly = now;
  await withScope(ctx.pool, PLATFORM, (c) =>
    c.query(
      `INSERT INTO camera_hourly (camera_id, tenant_id, hour, observed_s, online_s, recording_s)
       SELECT c.id, c.tenant_id, date_trunc('hour', to_timestamp($1 / 1000.0)), $2,
              CASE WHEN c.status = ANY($3) THEN $2 ELSE 0 END,
              CASE WHEN c.status = 'gravando' THEN $2 ELSE 0 END
         FROM cameras c JOIN tenants t ON t.id = c.tenant_id
        WHERE c.enabled AND c.deleted_at IS NULL AND t.status = 'active' AND t.deleted_at IS NULL
       ON CONFLICT (camera_id, hour) DO UPDATE
         SET observed_s = camera_hourly.observed_s + EXCLUDED.observed_s,
             online_s = camera_hourly.online_s + EXCLUDED.online_s,
             recording_s = camera_hourly.recording_s + EXCLUDED.recording_s`,
      [now, dt, ONLINE],
    ),
  );
}

// ------------------------------------------------------------------ amostras do dashboard
export async function sampleStatus(ctx: WorkerContext, state: MonitorState, now = Date.now()) {
  await withScope(ctx.pool, PLATFORM, async (c) => {
    const bytes = Number(
      (
        await c.query<{ b: string | null }>(
          "SELECT (metrics->>'bytes_received_total') AS b FROM ingest_nodes WHERE name = 'ingest-01'",
        )
      ).rows[0]?.b ?? NaN,
    );
    let bps: number | null = null;
    if (Number.isFinite(bytes)) {
      if (state.lastBytes && bytes >= state.lastBytes.bytes && now > state.lastBytes.at)
        bps = Math.round(
          ((bytes - state.lastBytes.bytes) * 8) / ((now - state.lastBytes.at) / 1000),
        );
      state.lastBytes = { at: now, bytes };
    }
    await c.query(
      `INSERT INTO status_samples (tenant_id, cameras, online, recording, offline, ingress_bps)
       SELECT NULLIF(g.tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), g.cameras, g.online, g.recording, g.offline,
              CASE WHEN g.tenant_id = '00000000-0000-0000-0000-000000000000'::uuid THEN $2::bigint END
         FROM (
           SELECT coalesce(c.tenant_id, '00000000-0000-0000-0000-000000000000'::uuid) AS tenant_id,
                  count(*)::int AS cameras,
                  count(*) FILTER (WHERE c.status = ANY($1))::int AS online,
                  count(*) FILTER (WHERE c.status = 'gravando')::int AS recording,
                  count(*) FILTER (WHERE c.status IN ('offline', 'erro'))::int AS offline
             FROM cameras c JOIN tenants t ON t.id = c.tenant_id
            WHERE c.enabled AND c.deleted_at IS NULL AND t.deleted_at IS NULL
            GROUP BY GROUPING SETS ((c.tenant_id), ())) g`,
      [ONLINE, bps],
    );
    await c.query("DELETE FROM status_samples WHERE sampled_at < now() - interval '7 days'");
    await c.query("DELETE FROM camera_hourly WHERE hour < now() - interval '400 days'");
    await c.query("DELETE FROM notifications WHERE created_at < now() - interval '90 days'");
  });
}

// ------------------------------------------------------------------ e-mail
const LEVEL_PT: Record<string, string> = {
  info: "INFORMAÇÃO",
  warning: "ATENÇÃO",
  error: "ERRO",
  critical: "CRÍTICO",
};

interface PendingAlert {
  id: string;
  rule: string;
  severity: string;
  title: string;
  opened_at: Date;
  resolved_at: Date | null;
  tenant_name: string | null;
}

export async function loadSmtp(ctx: WorkerContext): Promise<SmtpSettings> {
  const v = await withScope(ctx.pool, PLATFORM, (c) =>
    getSetting<Partial<SmtpSettings>>(c, "integrations.smtp", {}),
  );
  return { ...SMTP_DEFAULTS, ...v };
}

const fmt = (d: Date) =>
  d.toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    dateStyle: "short",
    timeStyle: "medium",
  });

export async function notifyAlerts(
  ctx: WorkerContext,
  state: MonitorState,
  deps: { send?: typeof sendMail; now?: number } = {},
): Promise<{ sent: number; failed: number; alerts: number }> {
  const now = deps.now ?? Date.now();
  const send = deps.send ?? sendMail;
  const out = { sent: 0, failed: 0, alerts: 0 };
  if (now < state.mailBackoffUntil) return out;
  const s = await loadSmtp(ctx);
  if (!s.enabled || !s.recipients.length) return out;
  const minRank = SEVERITY_RANK[s.min_severity] ?? 2;

  const { fresh, resolvedList } = await withScope(ctx.pool, PLATFORM, async (c) => {
    const base = `SELECT a.id::text, a.rule, a.severity, a.title, a.opened_at, a.resolved_at, t.name AS tenant_name
                    FROM alerts a LEFT JOIN tenants t ON t.id = a.tenant_id`;
    const fresh = (
      await c.query<PendingAlert>(
        `${base}
          WHERE a.status <> 'resolved'
            AND (CASE a.severity WHEN 'critical' THEN 3 WHEN 'error' THEN 2 WHEN 'warning' THEN 1 ELSE 0 END) >= $1
            AND (a.notified_severity IS NULL OR
                 (CASE a.severity WHEN 'critical' THEN 3 WHEN 'error' THEN 2 WHEN 'warning' THEN 1 ELSE 0 END) >
                 (CASE a.notified_severity WHEN 'critical' THEN 3 WHEN 'error' THEN 2 WHEN 'warning' THEN 1 ELSE 0 END))
          ORDER BY a.opened_at LIMIT 50`,
        [minRank],
      )
    ).rows;
    const resolvedList = s.notify_resolved
      ? (
          await c.query<PendingAlert>(
            `${base} WHERE a.status = 'resolved' AND a.notified_at IS NOT NULL AND a.resolved_notified_at IS NULL
              ORDER BY a.resolved_at LIMIT 50`,
          )
        ).rows
      : [];
    return { fresh, resolvedList };
  });

  const panel = ctx.env.PANEL_URL ? `${ctx.env.PANEL_URL.replace(/\/$/, "")}/eventos` : "";
  const batches: Array<{ kind: "alert" | "resolved" | "digest"; items: PendingAlert[] }> = [];
  if (fresh.length > 5) batches.push({ kind: "digest", items: fresh });
  else for (const a of fresh) batches.push({ kind: "alert", items: [a] });
  if (resolvedList.length) batches.push({ kind: "resolved", items: resolvedList });

  for (const b of batches) {
    const worst = b.items.reduce((m, a) => Math.max(m, SEVERITY_RANK[a.severity] ?? 0), 0);
    const worstLabel =
      Object.keys(SEVERITY_RANK).find((k) => SEVERITY_RANK[k] === worst) ?? "error";
    const subject =
      b.kind === "alert"
        ? `[TopCam] ${LEVEL_PT[b.items[0]!.severity]}: ${b.items[0]!.title}`
        : b.kind === "digest"
          ? `[TopCam] ${b.items.length} alertas abertos (pior: ${LEVEL_PT[worstLabel]})`
          : `[TopCam] Resolvido: ${b.items.length === 1 ? b.items[0]!.title : `${b.items.length} alertas`}`;
    const lines = b.items.map((a) =>
      b.kind === "resolved"
        ? `• ${a.title}\n  Aberto em ${fmt(a.opened_at)} · resolvido em ${a.resolved_at ? fmt(a.resolved_at) : "—"}`
        : `• [${LEVEL_PT[a.severity]}] ${a.title}${a.tenant_name ? ` — ${a.tenant_name}` : ""}\n  Desde ${fmt(a.opened_at)}`,
    );
    const text = [
      b.kind === "resolved" ? "Situação normalizada:" : "Alerta no TopCam:",
      "",
      ...lines,
      "",
      panel ? `Veja no painel: ${panel}` : "",
      "",
      "— TopCam (mensagem automática)",
    ].join("\n");
    try {
      await send(s, ctx.encKey, { to: s.recipients, subject, text });
      out.sent++;
      out.alerts += b.items.length;
      await withScope(ctx.pool, PLATFORM, async (c) => {
        const ids = b.items.map((a) => a.id);
        if (b.kind === "resolved")
          await c.query(
            "UPDATE alerts SET resolved_notified_at = now() WHERE id = ANY($1::bigint[])",
            [ids],
          );
        else
          await c.query(
            "UPDATE alerts SET notified_severity = severity, notified_at = now() WHERE id = ANY($1::bigint[])",
            [ids],
          );
        for (const a of b.items)
          await c.query(
            `INSERT INTO notifications (alert_id, kind, recipients, subject, status) VALUES ($1, $2, $3, $4, 'sent')`,
            [a.id, b.kind, s.recipients.join(", "), subject],
          );
      });
    } catch (err) {
      out.failed++;
      state.mailBackoffUntil = now + 5 * 60_000;
      const msg = (err as Error).message.slice(0, 500);
      ctx.log.warn({ err: msg }, "e-mail de alerta não enviado");
      await withScope(ctx.pool, PLATFORM, (c) =>
        c.query(
          `INSERT INTO notifications (alert_id, kind, recipients, subject, status, error) VALUES ($1, $2, $3, $4, 'failed', $5)`,
          [b.items[0]!.id, b.kind, s.recipients.join(", "), subject, msg],
        ),
      );
      break;
    }
  }
  return out;
}
