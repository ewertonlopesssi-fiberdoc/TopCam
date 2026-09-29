import { cameraVisibility, isPlatformRole } from "@topcam/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { db, effectiveTenant, paged } from "../lib/ctx.js";
import { badRequest, notFound, pagination, parseBody, uuid } from "../lib/http.js";

/**
 * Monitoramento (Fase 7).
 *
 *  GET  /api/v1/alerts                 alertas (ativos, reconhecidos, resolvidos), com filtros
 *  GET  /api/v1/alerts/summary         contagem dos ativos por gravidade (sino do cabeçalho)
 *  POST /api/v1/alerts/:id/ack         reconhecer   (alerts.write)
 *  POST /api/v1/alerts/:id/resolve     resolver     (alerts.write)
 *  GET  /api/v1/events                 eventos das câmeras e do sistema, com filtros
 *  GET  /api/v1/dashboard              números, gráficos de 24 h, alertas e eventos recentes
 *  GET  /api/v1/reports/availability   disponibilidade, gravação e lacunas por câmera (CSV opcional)
 *
 * Isolamento: RLS por cliente. Operador e visualizador só veem o que é das câmeras
 * concedidas a eles (alertas e eventos sem câmera ficam só para a administração).
 */

const SEVERITIES = ["info", "warning", "error", "critical"] as const;

const alertQuery = pagination.extend({
  status: z.enum(["active", "open", "acknowledged", "resolved", "all"]).default("active"),
  severity: z.enum(SEVERITIES).optional(),
  tenantId: uuid.optional(),
  cameraId: uuid.optional(),
});

const eventQuery = pagination.extend({
  type: z.string().max(60).optional(),
  severity: z.enum(SEVERITIES).optional(),
  tenantId: uuid.optional(),
  cameraId: uuid.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  q: z.string().trim().max(100).optional(),
});

const reportQuery = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  tenantId: uuid.optional(),
  format: z.enum(["json", "csv"]).default("json"),
});

function granted(req: FastifyRequest) {
  return { granted: cameraVisibility(req.user!.role) === "granted", userId: req.user!.id };
}

/** Condição SQL: linha visível para o usuário ($n = granted, $n+1 = userId). */
const VISIBLE = (alias: string, n: number) =>
  `($${n}::boolean = false OR (${alias}.camera_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM user_camera_permissions p WHERE p.camera_id = ${alias}.camera_id AND p.user_id = $${n + 1})))`;

export async function monitoringRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: app.authenticate };
  const alertsWrite = { preHandler: app.requirePermission("alerts.write") };
  const reports = { preHandler: app.requirePermission("reports.read") };

  // ------------------------------------------------------------------ alertas
  app.get("/api/v1/alerts", auth, async (req) => {
    const q = parseBody(alertQuery, req.query);
    const tenant = effectiveTenant(req, q.tenantId ?? null);
    const v = granted(req);
    const rows = await db(
      app,
      req,
      async (c) =>
        (
          await c.query(
            `SELECT count(*) OVER() AS total, a.id::text, a.rule, a.severity, a.title, a.details, a.status,
                  a.opened_at AS "openedAt", a.updated_at AS "updatedAt", a.acknowledged_at AS "acknowledgedAt",
                  a.resolved_at AS "resolvedAt", a.notified_at AS "notifiedAt",
                  ua.name AS "acknowledgedBy", ur.name AS "resolvedBy",
                  a.tenant_id AS "tenantId", t.name AS "tenantName",
                  a.camera_id AS "cameraId", c.code AS "cameraCode", c.name AS "cameraName"
             FROM alerts a
             LEFT JOIN tenants t ON t.id = a.tenant_id
             LEFT JOIN cameras c ON c.id = a.camera_id
             LEFT JOIN users ua ON ua.id = a.acknowledged_by
             LEFT JOIN users ur ON ur.id = a.resolved_by
            WHERE ($1::text = 'all'
                   OR ($1 = 'active' AND a.status <> 'resolved')
                   OR a.status = $1)
              AND ($2::text IS NULL OR a.severity = $2)
              AND ($3::uuid IS NULL OR a.tenant_id = $3)
              AND ($4::uuid IS NULL OR a.camera_id = $4)
              AND ${VISIBLE("a", 5)}
            ORDER BY CASE WHEN a.status = 'resolved' THEN 1 ELSE 0 END,
                     CASE a.severity WHEN 'critical' THEN 0 WHEN 'error' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
                     coalesce(a.resolved_at, a.opened_at) DESC
            LIMIT $7 OFFSET $8`,
            [
              q.status,
              q.severity ?? null,
              tenant,
              q.cameraId ?? null,
              v.granted,
              v.userId,
              q.pageSize,
              (q.page - 1) * q.pageSize,
            ],
          )
        ).rows as Array<{ total: string }>,
    );
    return paged(rows, q.page, q.pageSize);
  });

  app.get("/api/v1/alerts/summary", auth, async (req) => {
    const v = granted(req);
    const r = await db(
      app,
      req,
      async (c) =>
        (
          await c.query<{ severity: string; n: number }>(
            `SELECT a.severity, count(*)::int AS n FROM alerts a
            WHERE a.status <> 'resolved' AND ${VISIBLE("a", 1)} GROUP BY a.severity`,
            [v.granted, v.userId],
          )
        ).rows,
    );
    const by = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<string, number>;
    for (const x of r) by[x.severity] = x.n;
    return { total: r.reduce((a, x) => a + x.n, 0), bySeverity: by };
  });

  async function changeAlert(req: FastifyRequest, reply: FastifyReply, action: "ack" | "resolve") {
    const id = parseBody(z.coerce.number().int().positive(), (req.params as { id: string }).id);
    return db(app, req, async (c) => {
      const cur = (
        await c.query<{ status: string; title: string; tenant_id: string | null; rule: string }>(
          "SELECT status, title, tenant_id, rule FROM alerts WHERE id = $1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!cur) throw notFound("Alerta não encontrado");
      if (!isPlatformRole(req.user!.role) && !cur.tenant_id)
        throw notFound("Alerta não encontrado");
      if (cur.status === "resolved") throw badRequest("O alerta já está resolvido");
      if (action === "ack") {
        if (cur.status === "acknowledged") return reply.send({ ok: true });
        await c.query(
          `UPDATE alerts SET status = 'acknowledged', acknowledged_at = now(), acknowledged_by = $2, updated_at = now()
            WHERE id = $1`,
          [id, req.user!.id],
        );
      } else {
        await c.query(
          `UPDATE alerts SET status = 'resolved', resolved_at = now(), resolved_by = $2, updated_at = now()
            WHERE id = $1`,
          [id, req.user!.id],
        );
      }
      await audit(c, req, action === "ack" ? "alert.acknowledged" : "alert.resolved", {
        tenantId: cur.tenant_id,
        entityType: "alert",
        entityId: String(id),
        data: { title: cur.title, rule: cur.rule },
      });
      return reply.send({ ok: true });
    });
  }
  app.post("/api/v1/alerts/:id/ack", alertsWrite, (req, reply) => changeAlert(req, reply, "ack"));
  app.post("/api/v1/alerts/:id/resolve", alertsWrite, (req, reply) =>
    changeAlert(req, reply, "resolve"),
  );

  // ------------------------------------------------------------------ eventos
  app.get("/api/v1/events", auth, async (req) => {
    const q = parseBody(eventQuery, req.query);
    const tenant = effectiveTenant(req, q.tenantId ?? null);
    const v = granted(req);
    const rows = await db(
      app,
      req,
      async (c) =>
        (
          await c.query(
            `SELECT count(*) OVER() AS total, e.id::text, e.type, e.severity, e.message, e.data,
                  e.occurred_at AS "occurredAt", e.tenant_id AS "tenantId", t.name AS "tenantName",
                  e.camera_id AS "cameraId", c.code AS "cameraCode", c.name AS "cameraName"
             FROM camera_events e
             LEFT JOIN tenants t ON t.id = e.tenant_id
             LEFT JOIN cameras c ON c.id = e.camera_id
            WHERE ($1::text IS NULL OR e.type = $1)
              AND ($2::text IS NULL OR e.severity = $2)
              AND ($3::uuid IS NULL OR e.tenant_id = $3)
              AND ($4::uuid IS NULL OR e.camera_id = $4)
              AND ($5::timestamptz IS NULL OR e.occurred_at >= $5)
              AND ($6::timestamptz IS NULL OR e.occurred_at < $6)
              AND ($7::text IS NULL OR e.message ILIKE '%' || $7 || '%' OR c.code ILIKE '%' || $7 || '%'
                   OR c.name ILIKE '%' || $7 || '%')
              AND ${VISIBLE("e", 8)}
            ORDER BY e.occurred_at DESC, e.id DESC
            LIMIT $10 OFFSET $11`,
            [
              q.type ?? null,
              q.severity ?? null,
              tenant,
              q.cameraId ?? null,
              q.from ?? null,
              q.to ?? null,
              q.q || null,
              v.granted,
              v.userId,
              q.pageSize,
              (q.page - 1) * q.pageSize,
            ],
          )
        ).rows as Array<{ total: string }>,
    );
    return paged(rows, q.page, q.pageSize);
  });

  // ------------------------------------------------------------------ dashboard
  app.get("/api/v1/dashboard", auth, async (req) => {
    const u = req.user!;
    const platform = isPlatformRole(u.role);
    const v = granted(req);
    return db(app, req, async (c) => {
      const cams = (
        await c.query<Record<string, number>>(
          `SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE c.status IN ('recebendo', 'validando', 'ao_vivo', 'gravando'))::int AS online,
                  count(*) FILTER (WHERE c.status = 'gravando')::int AS recording,
                  count(*) FILTER (WHERE c.status IN ('offline', 'erro'))::int AS offline,
                  count(*) FILTER (WHERE c.status IN ('aguardando_transmissao', 'conectando'))::int AS waiting
             FROM cameras c JOIN tenants t ON t.id = c.tenant_id
            WHERE c.deleted_at IS NULL AND c.enabled AND t.deleted_at IS NULL
              AND ($1::boolean = false OR EXISTS (SELECT 1 FROM user_camera_permissions p
                    WHERE p.camera_id = c.id AND p.user_id = $2))`,
          [v.granted, v.userId],
        )
      ).rows[0]!;
      const samples = v.granted
        ? []
        : (
            await c.query(
              `SELECT sampled_at AS at, sum(cameras)::int AS cameras, sum(online)::int AS online,
                      sum(recording)::int AS recording, sum(offline)::int AS offline,
                      max(ingress_bps)::float8 AS "ingressBps"
                 FROM status_samples
                WHERE sampled_at > now() - interval '24 hours'
                  AND (CASE WHEN $1::boolean THEN tenant_id IS NULL ELSE tenant_id IS NOT NULL END)
                GROUP BY sampled_at ORDER BY sampled_at`,
              [platform],
            )
          ).rows;
      const alerts = (
        await c.query(
          `SELECT a.id::text, a.severity, a.title, a.opened_at AS "openedAt", a.status
             FROM alerts a WHERE a.status <> 'resolved' AND ${VISIBLE("a", 1)}
            ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'error' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
                     a.opened_at DESC LIMIT 6`,
          [v.granted, v.userId],
        )
      ).rows;
      const events = (
        await c.query(
          `SELECT e.id::text, e.type, e.severity, e.message, e.occurred_at AS "occurredAt",
                  c.code AS "cameraCode"
             FROM camera_events e LEFT JOIN cameras c ON c.id = e.camera_id
            WHERE ${VISIBLE("e", 1)} ORDER BY e.occurred_at DESC LIMIT 8`,
          [v.granted, v.userId],
        )
      ).rows;
      const extra = platform
        ? {
            tenants: (
              await c.query<{ n: number }>(
                "SELECT count(*)::int AS n FROM tenants WHERE status = 'active' AND deleted_at IS NULL",
              )
            ).rows[0]!.n,
            storage: (
              await c.query(
                `SELECT name, status, used_pct::float8 AS "usedPct", free_bytes::float8 AS "freeBytes",
                        write_latency_ms AS "writeLatencyMs", recording_blocked AS "recordingBlocked"
                   FROM storage_nodes ORDER BY created_at`,
              )
            ).rows,
          }
        : {};
      const usersOnline = (
        await c.query<{ web: number; app: number }>(
          `SELECT count(DISTINCT s.user_id) FILTER (WHERE s.client = 'web')::int AS web,
                  count(DISTINCT s.user_id) FILTER (WHERE s.client = 'mobile')::int AS app
             FROM sessions s
            WHERE s.revoked_at IS NULL AND s.expires_at > now() AND s.last_seen_at > now() - interval '15 minutes'`,
        )
      ).rows[0]!;
      return { cameras: cams, samples, alerts, events, usersOnline, ...extra };
    });
  });

  // ------------------------------------------------------------------ relatórios
  app.get("/api/v1/reports/availability", reports, async (req, reply) => {
    const q = parseBody(reportQuery, req.query);
    if (q.to <= q.from) throw badRequest("Período inválido");
    if (q.to.getTime() - q.from.getTime() > 93 * 86400_000)
      throw badRequest("Período máximo: 93 dias");
    const tenant = effectiveTenant(req, q.tenantId ?? null);
    const rows = await db(
      app,
      req,
      async (c) =>
        (
          await c.query<{
            cameraId: string;
            code: string;
            name: string;
            tenantName: string;
            recordingEnabled: boolean;
            observedS: number;
            onlineS: number;
            recordingS: number;
            offlineEvents: number;
            gaps: number;
            gapSeconds: number;
            recordedBytes: number;
          }>(
            `SELECT c.id AS "cameraId", c.code, c.name, t.name AS "tenantName",
                  c.recording_enabled AS "recordingEnabled",
                  coalesce(h.observed, 0)::int AS "observedS", coalesce(h.online, 0)::int AS "onlineS",
                  coalesce(h.recording, 0)::int AS "recordingS",
                  (SELECT count(*)::int FROM camera_events e WHERE e.camera_id = c.id AND e.type = 'stream_offline'
                     AND e.occurred_at >= $1 AND e.occurred_at < $2) AS "offlineEvents",
                  (SELECT count(*)::int FROM camera_events e WHERE e.camera_id = c.id AND e.type = 'recording_gap'
                     AND e.occurred_at >= $1 AND e.occurred_at < $2) AS "gaps",
                  (SELECT coalesce(round(sum((e.data->>'gap_seconds')::numeric)), 0)::int FROM camera_events e
                    WHERE e.camera_id = c.id AND e.type = 'recording_gap'
                      AND e.occurred_at >= $1 AND e.occurred_at < $2) AS "gapSeconds",
                  (SELECT coalesce(sum(s.size_bytes), 0)::float8 FROM recording_segments s
                    WHERE s.camera_id = c.id AND s.started_at >= $1 AND s.started_at < $2) AS "recordedBytes"
             FROM cameras c
             JOIN tenants t ON t.id = c.tenant_id
             LEFT JOIN LATERAL (
               SELECT sum(observed_s) AS observed, sum(online_s) AS online, sum(recording_s) AS recording
                 FROM camera_hourly x WHERE x.camera_id = c.id AND x.hour >= date_trunc('hour', $1::timestamptz)
                  AND x.hour < $2) h ON true
            WHERE c.deleted_at IS NULL AND ($3::uuid IS NULL OR c.tenant_id = $3)
            ORDER BY t.name, c.code`,
            [q.from, q.to, tenant],
          )
        ).rows,
    );
    const items = rows.map((r) => ({
      ...r,
      availabilityPct: r.observedS ? Math.round((r.onlineS / r.observedS) * 1000) / 10 : null,
      recordingPct:
        r.recordingEnabled && r.observedS
          ? Math.round((r.recordingS / r.observedS) * 1000) / 10
          : null,
    }));
    if (q.format === "csv") {
      const esc = (v: unknown) => {
        const s = v === null || v === undefined ? "" : String(v);
        return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const header = [
        "Cliente",
        "Câmera",
        "Nome",
        "Disponibilidade (%)",
        "Horas observadas",
        "Horas no ar",
        "Gravação (%)",
        "Horas gravando",
        "Quedas",
        "Lacunas",
        "Segundos em lacunas",
        "Gravado (GB)",
      ];
      // Planilha em português: números com vírgula decimal e ";" como separador.
      const n = (v: number | null, d = 1) => (v === null ? "" : v.toFixed(d).replace(".", ","));
      const lines = items.map((i) =>
        [
          esc(i.tenantName),
          esc(i.code),
          esc(i.name),
          n(i.availabilityPct),
          n(i.observedS / 3600),
          n(i.onlineS / 3600),
          n(i.recordingPct),
          n(i.recordingS / 3600),
          i.offlineEvents,
          i.gaps,
          i.gapSeconds,
          n(i.recordedBytes / 1e9, 2),
        ].join(";"),
      );
      const csv = "\uFEFF" + [header.join(";"), ...lines].join("\r\n");
      const name = `disponibilidade_${q.from.toISOString().slice(0, 10)}_${q.to.toISOString().slice(0, 10)}.csv`;
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="${name}"`)
        .send(csv);
    }
    return { from: q.from.toISOString(), to: q.to.toISOString(), items };
  });
}
