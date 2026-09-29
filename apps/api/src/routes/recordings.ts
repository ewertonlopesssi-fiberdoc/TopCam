import { getSetting, PLATFORM, withScope } from "@topcam/db";
import { cameraVisibility } from "@topcam/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { db } from "../lib/ctx.js";
import { badRequest, notFound, parseBody, uuid } from "../lib/http.js";
import { playbackRoutes } from "./playback.js";

/**
 * Gravações (Fase 4): resumo e índice dos segmentos de uma câmera.
 * A reprodução (linha do tempo, player, exportação) usa estes dados na Fase 5.
 *
 * Operador/visualizador só veem gravações de câmeras com "pode reproduzir".
 */

const rangeQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/** Maior intervalo pedido de uma vez (a linha do tempo pede um dia). */
const MAX_RANGE_MS = 7 * 24 * 3600 * 1000;
const GAP_MS = 3000;

export async function recordingRoutes(app: FastifyInstance): Promise<void> {
  const read = { preHandler: app.requirePermission("cameras.read") };

  async function loadCam(req: FastifyRequest, id: string) {
    const granted = cameraVisibility(req.user!.role) === "granted";
    const row = await db(
      app,
      req,
      async (c) =>
        (
          await c.query<{
            id: string;
            code: string;
            recordingEnabled: boolean;
            lastDurableSegmentAt: string | null;
            retentionHours: number | null;
            status: string;
            name: string;
            canExport: boolean;
          }>(
            `SELECT c.id, c.code, c.name, c.recording_enabled AS "recordingEnabled", c.status,
                  ($2::boolean = false OR EXISTS (
                    SELECT 1 FROM user_camera_permissions p
                     WHERE p.camera_id = c.id AND p.user_id = $3 AND p.can_export)) AS "canExport",
                  c.last_durable_segment_at AS "lastDurableSegmentAt",
                  rp.retention_hours AS "retentionHours"
             FROM cameras c LEFT JOIN retention_policies rp ON rp.id = c.retention_policy_id
            WHERE c.id = $1 AND c.deleted_at IS NULL
              AND ($2::boolean = false OR EXISTS (
                    SELECT 1 FROM user_camera_permissions p
                     WHERE p.camera_id = c.id AND p.user_id = $3 AND p.can_playback))`,
            [id, granted, req.user!.id],
          )
        ).rows[0],
    );
    if (!row) throw notFound("Câmera não encontrada");
    return row;
  }

  app.get<{ Params: { id: string } }>(
    "/api/v1/cameras/:id/recordings/summary",
    read,
    async (req) => {
      const id = parseBody(uuid, req.params.id);
      const cam = await loadCam(req, id);
      const globalEnabled = await withScope(app.deps.pool, PLATFORM, (c) =>
        getSetting<boolean>(c, "recording.globally_enabled", false),
      );
      const stats = await db(app, req, async (c) => {
        const s = (
          await c.query<{
            segments: number;
            bytes: string | null;
            oldest: string | null;
            newest: string | null;
            corrupt: number;
            missing: number;
            writing: number;
          }>(
            `SELECT count(*) FILTER (WHERE state = 'verified')::int AS segments,
                    sum(size_bytes) FILTER (WHERE state = 'verified')::text AS bytes,
                    min(started_at) FILTER (WHERE state = 'verified') AS oldest,
                    max(ended_at) FILTER (WHERE state = 'verified') AS newest,
                    count(*) FILTER (WHERE state = 'corrupt')::int AS corrupt,
                    count(*) FILTER (WHERE state = 'missing')::int AS missing,
                    count(*) FILTER (WHERE state = 'writing')::int AS writing
               FROM recording_segments WHERE camera_id = $1 AND state <> 'deleted'`,
            [id],
          )
        ).rows[0]!;
        const gaps = (
          await c.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM camera_events
              WHERE camera_id = $1 AND type = 'recording_gap' AND occurred_at > now() - interval '24 hours'`,
            [id],
          )
        ).rows[0]!.n;
        return { ...s, gaps24h: gaps };
      });
      return {
        cameraId: id,
        code: cam.code,
        name: cam.name,
        status: cam.status,
        canExport: cam.canExport,
        recordingEnabled: cam.recordingEnabled,
        globalEnabled,
        retentionHours: cam.retentionHours ?? (cam.recordingEnabled ? 24 : null),
        lastDurableSegmentAt: cam.lastDurableSegmentAt,
        segments: stats.segments,
        bytes: Number(stats.bytes ?? 0),
        oldest: stats.oldest,
        newest: stats.newest,
        corrupt: stats.corrupt,
        missing: stats.missing,
        writing: stats.writing,
        gaps24h: stats.gaps24h,
      };
    },
  );

  /** Segmentos conferidos num intervalo e as lacunas entre eles (base da linha do tempo). */
  app.get<{ Params: { id: string } }>("/api/v1/cameras/:id/recordings", read, async (req) => {
    const id = parseBody(uuid, req.params.id);
    const q = parseBody(rangeQuery, req.query);
    await loadCam(req, id);
    const to = q.to ?? new Date();
    const from = q.from ?? new Date(to.getTime() - 24 * 3600 * 1000);
    if (to.getTime() - from.getTime() > MAX_RANGE_MS || to <= from)
      throw badRequest("Intervalo inválido (máximo 7 dias)");
    const segments = await db(
      app,
      req,
      async (c) =>
        (
          await c.query<{
            id: string;
            startedAt: Date;
            endedAt: Date;
            durationMs: number;
            sizeBytes: string;
            videoCodec: string | null;
            audioCodec: string | null;
            holes: Array<{ from: number; to: number }> | null;
          }>(
            `SELECT id::text, started_at AS "startedAt", ended_at AS "endedAt", duration_ms AS "durationMs",
                  size_bytes::text AS "sizeBytes", video_codec AS "videoCodec", audio_codec AS "audioCodec",
                  holes
             FROM recording_segments
            WHERE camera_id = $1 AND state = 'verified' AND ended_at > $2 AND started_at < $3
            ORDER BY started_at
            LIMIT 20000`,
            [id, from, to],
          )
        ).rows,
    );
    const gaps: Array<{ from: string; to: string; seconds: number; internal?: true }> = [];
    // Buracos dentro de segmentos (quadros perdidos; Fase 6).
    for (const s of segments)
      for (const h of s.holes ?? [])
        gaps.push({
          from: new Date(s.startedAt.getTime() + h.from * 1000).toISOString(),
          to: new Date(s.startedAt.getTime() + h.to * 1000).toISOString(),
          seconds: Math.round((h.to - h.from) * 10) / 10,
          internal: true,
        });
    for (let i = 1; i < segments.length; i++) {
      const a = segments[i - 1]!;
      const b = segments[i]!;
      const ms = b.startedAt.getTime() - a.endedAt.getTime();
      if (ms > GAP_MS)
        gaps.push({
          from: a.endedAt.toISOString(),
          to: b.startedAt.toISOString(),
          seconds: Math.round(ms / 100) / 10,
        });
    }
    gaps.sort((a, b) => a.from.localeCompare(b.from));
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      segments: segments.map((s) => ({
        ...s,
        holes: s.holes ?? [],
        sizeBytes: Number(s.sizeBytes),
      })),
      gaps,
    };
  });

  // Reprodução e exportação usam a mesma regra de acesso (pode reproduzir / pode exportar).
  await playbackRoutes(app, loadCam);
}
