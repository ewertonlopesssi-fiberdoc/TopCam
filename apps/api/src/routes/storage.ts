import { PLATFORM, getSetting, withScope } from "@topcam/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { badRequest, notFound, parseBody, uuid } from "../lib/http.js";

/**
 * Armazenamento e servidores (Fase 6) — equipe da plataforma.
 *
 *  GET  /api/v1/storage                  discos de vídeo, uso por cliente e câmera,
 *                                        previsão, latência, alertas e eventos
 *  PATCH /api/v1/storage/nodes/:id       limites (70/85/95%) e cota do nó
 *  PUT  /api/v1/storage/settings         limpeza de emergência (liga/desliga, idade mínima)
 *  GET  /api/v1/servers                  servidor de mídia, CPU, memória, disco do sistema,
 *                                        pressão de IO e serviços
 */

// GB decimal (10^9), igual ao que o painel mostra.
const GB = 1e9;

const nodeBody = z
  .object({
    warnPct: z.number().int().min(1).max(99).optional(),
    highPct: z.number().int().min(1).max(99).optional(),
    criticalPct: z.number().int().min(1).max(99).optional(),
    quotaGb: z.number().positive().max(10_000_000).nullable().optional(),
  })
  .strict();

const settingsBody = z
  .object({
    emergencyPurge: z.boolean().optional(),
    purgeMinAgeMinutes: z
      .number()
      .int()
      .min(0)
      .max(7 * 24 * 60)
      .optional(),
  })
  .strict();

const STORAGE_RULES = [
  "storage_level",
  "storage_purge",
  "storage_blocked",
  "storage_slow",
  "tenant_quota",
  "system_disk",
];
const STORAGE_EVENTS = [
  "storage_level",
  "storage_purge",
  "storage_recording_blocked",
  "storage_recording_resumed",
  "storage_slow",
  "tenant_quota",
  "system_disk",
];

export async function storageRoutes(app: FastifyInstance): Promise<void> {
  const { pool } = app.deps;
  const read = { preHandler: app.requirePermission("storage.read") };
  const write = { preHandler: app.requirePermission("storage.write") };

  app.get("/api/v1/storage", read, async () =>
    withScope(pool, PLATFORM, async (c) => {
      const nodes = (
        await c.query(
          `SELECT n.id, n.name, n.mount_path AS "mountPath", n.status,
                  n.total_bytes::float8 AS "totalBytes", n.free_bytes::float8 AS "freeBytes",
                  n.used_bytes::float8 AS "usedBytes", n.used_pct::float8 AS "usedPct",
                  n.segments_bytes::float8 AS "segmentsBytes", n.quota_bytes::float8 AS "quotaBytes",
                  n.warn_pct AS "warnPct", n.high_pct AS "highPct", n.critical_pct AS "criticalPct",
                  n.recording_blocked AS "recordingBlocked", n.write_latency_ms AS "writeLatencyMs",
                  n.last_seen_at AS "lastSeenAt", n.last_purge_at AS "lastPurgeAt",
                  (SELECT max(write_latency_ms) FROM storage_samples x
                    WHERE x.storage_node_id = n.id AND x.sampled_at > now() - interval '24 hours') AS "latencyMax24h",
                  (SELECT count(*)::int FROM cameras c
                    WHERE c.storage_node_id = n.id AND c.deleted_at IS NULL AND c.recording_enabled) AS "recordingCameras",
                  -- Volume em regime: o gravado na última hora × retenção de cada câmera.
                  (SELECT coalesce(sum(h.bytes * coalesce(rp.retention_hours, 24)), 0)::float8
                     FROM cameras c
                     LEFT JOIN retention_policies rp ON rp.id = c.retention_policy_id
                     CROSS JOIN LATERAL (
                       SELECT coalesce(sum(s.size_bytes), 0) AS bytes FROM recording_segments s
                        WHERE s.camera_id = c.id AND s.state = 'verified'
                          AND s.started_at > now() - interval '1 hour') h
                    WHERE c.storage_node_id = n.id AND c.deleted_at IS NULL AND c.recording_enabled) AS "projectedBytes",
                  (SELECT coalesce(sum(size_bytes), 0)::float8 FROM recording_segments s
                    WHERE s.storage_node_id = n.id AND s.started_at > now() - interval '24 hours'
                      AND s.state <> 'deleted') AS "last24hBytes"
             FROM storage_nodes n ORDER BY n.created_at`,
        )
      ).rows;
      const samples = (
        await c.query(
          `SELECT storage_node_id AS "nodeId", sampled_at AS "at", used_pct::float8 AS "usedPct",
                  write_latency_ms AS "latencyMs"
             FROM storage_samples WHERE sampled_at > now() - interval '24 hours'
            ORDER BY sampled_at`,
        )
      ).rows;
      const tenants = (
        await c.query(
          `SELECT t.id, t.name, t.storage_quota_bytes::float8 AS "quotaBytes",
                  coalesce(u.bytes, 0)::float8 AS "usedBytes", coalesce(u.cams, 0)::int AS "cameras"
             FROM tenants t
             LEFT JOIN LATERAL (
               SELECT sum(s.size_bytes) AS bytes, count(DISTINCT s.camera_id) AS cams
                 FROM recording_segments s WHERE s.tenant_id = t.id AND s.state <> 'deleted') u ON true
            WHERE t.deleted_at IS NULL
            ORDER BY coalesce(u.bytes, 0) DESC, t.name`,
        )
      ).rows;
      const cameras = (
        await c.query(
          `SELECT c.id, c.code, c.name, t.name AS "tenantName", n.name AS "nodeName",
                  c.recording_enabled AS "recordingEnabled",
                  coalesce(rp.retention_hours, 24) AS "retentionHours",
                  x.bytes::float8 AS bytes, x.segments::int AS segments, x.oldest, x.seconds::float8 AS seconds,
                  (SELECT coalesce(sum(s.size_bytes), 0) * 8 / 3600.0 FROM recording_segments s
                    WHERE s.camera_id = c.id AND s.state = 'verified'
                      AND s.started_at > now() - interval '1 hour')::float8 AS "bitsPerSecond"
             FROM cameras c
             JOIN tenants t ON t.id = c.tenant_id
             LEFT JOIN storage_nodes n ON n.id = c.storage_node_id
             LEFT JOIN retention_policies rp ON rp.id = c.retention_policy_id
             JOIN LATERAL (
               SELECT coalesce(sum(s.size_bytes), 0) AS bytes, count(*) AS segments, min(s.started_at) AS oldest,
                      coalesce(sum(s.duration_ms), 0) / 1000.0 AS seconds
                 FROM recording_segments s WHERE s.camera_id = c.id AND s.state <> 'deleted') x ON true
            WHERE c.deleted_at IS NULL AND (c.recording_enabled OR x.segments > 0)
            ORDER BY x.bytes DESC`,
        )
      ).rows;
      const alerts = (
        await c.query(
          `SELECT a.id::text, a.rule, a.severity, a.title, a.details, a.opened_at AS "openedAt",
                  a.updated_at AS "updatedAt", a.storage_node_id AS "nodeId", a.tenant_id AS "tenantId"
             FROM alerts a WHERE a.status <> 'resolved' AND a.rule = ANY($1)
            ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'error' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
                     a.opened_at DESC`,
          [STORAGE_RULES],
        )
      ).rows;
      const events = (
        await c.query(
          `SELECT e.id::text, e.type, e.severity, e.message, e.data, e.occurred_at AS "occurredAt"
             FROM camera_events e WHERE e.type = ANY($1)
            ORDER BY e.occurred_at DESC LIMIT 30`,
          [STORAGE_EVENTS],
        )
      ).rows;
      return {
        nodes,
        samples,
        tenants,
        cameras,
        alerts,
        events,
        settings: {
          emergencyPurge: await getSetting<boolean>(c, "storage.emergency_purge", true),
          purgeMinAgeMinutes: Number(
            await getSetting<number>(c, "storage.purge_min_age_minutes", 60),
          ),
        },
      };
    }),
  );

  app.patch<{ Params: { id: string } }>("/api/v1/storage/nodes/:id", write, async (req) => {
    const id = parseBody(uuid, req.params.id);
    const b = parseBody(nodeBody, req.body);
    return withScope(pool, PLATFORM, async (c) => {
      const cur = (
        await c.query<{ warn_pct: number; high_pct: number; critical_pct: number; name: string }>(
          "SELECT name, warn_pct, high_pct, critical_pct FROM storage_nodes WHERE id = $1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!cur) throw notFound("Disco não encontrado");
      const warn = b.warnPct ?? cur.warn_pct;
      const high = b.highPct ?? cur.high_pct;
      const crit = b.criticalPct ?? cur.critical_pct;
      if (!(warn < high && high < crit))
        throw badRequest("Os limites precisam ser crescentes: atenção < alto < crítico");
      const quota =
        b.quotaGb === undefined
          ? undefined
          : b.quotaGb === null
            ? null
            : Math.round(b.quotaGb * GB);
      await c.query(
        `UPDATE storage_nodes SET warn_pct = $2, high_pct = $3, critical_pct = $4,
                quota_bytes = CASE WHEN $5::boolean THEN $6::bigint ELSE quota_bytes END, updated_at = now()
          WHERE id = $1`,
        [id, warn, high, crit, quota !== undefined, quota ?? null],
      );
      await audit(c, req, "storage.node_updated", {
        tenantId: null,
        entityType: "storage_node",
        entityId: id,
        data: {
          name: cur.name,
          warnPct: warn,
          highPct: high,
          criticalPct: crit,
          quotaBytes: quota,
        },
      });
      return { ok: true };
    });
  });

  app.put("/api/v1/storage/settings", write, async (req) => {
    const b = parseBody(settingsBody, req.body);
    await withScope(pool, PLATFORM, async (c) => {
      const changes: Record<string, unknown> = {};
      if (b.emergencyPurge !== undefined) changes["storage.emergency_purge"] = b.emergencyPurge;
      if (b.purgeMinAgeMinutes !== undefined)
        changes["storage.purge_min_age_minutes"] = b.purgeMinAgeMinutes;
      for (const [key, value] of Object.entries(changes))
        await c.query(
          `INSERT INTO system_settings (key, value, updated_by) VALUES ($1, $2, $3)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`,
          [key, JSON.stringify(value), req.user!.id],
        );
      await audit(c, req, "settings.updated", {
        tenantId: null,
        entityType: "settings",
        data: { changes },
      });
    });
    return { ok: true };
  });

  app.get("/api/v1/servers", read, async () =>
    withScope(pool, PLATFORM, async (c) => ({
      items: (
        await c.query(
          `SELECT i.id, i.name, i.public_host AS "publicHost", i.rtmp_port AS "rtmpPort",
                  i.capacity_streams AS "capacityStreams", i.status, i.last_seen_at AS "lastSeenAt",
                  i.metrics,
                  (SELECT count(*)::int FROM cameras c WHERE c.deleted_at IS NULL AND c.enabled
                     AND c.status IN ('recebendo', 'validando', 'ao_vivo', 'gravando')) AS "camerasOnline",
                  (SELECT count(*)::int FROM cameras c WHERE c.deleted_at IS NULL AND c.status = 'gravando') AS "camerasRecording",
                  (SELECT count(*)::int FROM cameras c WHERE c.deleted_at IS NULL AND c.enabled) AS "camerasEnabled"
             FROM ingest_nodes i ORDER BY i.created_at`,
        )
      ).rows,
      alerts: (
        await c.query(
          `SELECT a.id::text, a.rule, a.severity, a.title, a.opened_at AS "openedAt"
             FROM alerts a WHERE a.status <> 'resolved'
              AND a.rule = ANY('{ingest_unreachable,system_disk,storage_slow,storage_blocked}')
            ORDER BY a.opened_at DESC`,
        )
      ).rows,
    })),
  );
}
