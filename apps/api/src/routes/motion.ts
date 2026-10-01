import { cameraVisibility } from "@topcam/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, paged } from "../lib/ctx.js";
import { pagination, parseBody } from "../lib/http.js";

/**
 * Alarmes (movimentos) das câmeras que o usuário vê — tela Alarmes do app.
 * Operador/visualizador: só câmeras concedidas. `canPlayback` diz se ele pode abrir a gravação.
 */
const query = pagination.extend({
  cameraId: z.string().uuid().optional(),
  since: z.coerce.date().optional(),
});

export async function motionRoutes(app: FastifyInstance): Promise<void> {
  const read = { preHandler: app.requirePermission("cameras.read") };

  app.get("/api/v1/motion-events", read, async (req) => {
    const q = parseBody(query, req.query);
    const granted = cameraVisibility(req.user!.role) === "granted";
    const rows = await db(
      app,
      req,
      async (c) =>
        (
          await c.query(
            `SELECT count(*) OVER() AS total, m.id::text, m.camera_id AS "cameraId", c.code, c.name AS "cameraName",
                    l.name AS "locationName", t.name AS "tenantName", m.kind, m.source,
                    m.started_at AS "startedAt", m.ended_at AS "endedAt", m.hits,
                    ($1::boolean = false OR coalesce(p.can_playback, false)) AS "canPlayback",
                    c.recording_enabled AS "recordingEnabled"
               FROM motion_events m
               JOIN cameras c ON c.id = m.camera_id AND c.deleted_at IS NULL
               JOIN tenants t ON t.id = m.tenant_id
               JOIN locations l ON l.id = c.location_id
               LEFT JOIN user_camera_permissions p ON p.camera_id = c.id AND p.user_id = $2
              WHERE ($1::boolean = false OR p.can_live OR p.can_playback)
                AND ($3::uuid IS NULL OR m.camera_id = $3)
                AND ($4::timestamptz IS NULL OR m.started_at >= $4)
              ORDER BY m.started_at DESC
              LIMIT $5 OFFSET $6`,
            [
              granted,
              req.user!.id,
              q.cameraId ?? null,
              q.since ?? null,
              q.pageSize,
              (q.page - 1) * q.pageSize,
            ],
          )
        ).rows,
    );
    return paged(rows, q.page, q.pageSize);
  });
}
