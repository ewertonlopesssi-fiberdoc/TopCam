import {
  insertCameraEvent,
  nextCameraCode,
  rotateStreamKey,
  transitionCamera,
  type PoolClient,
} from "@topcam/db";
import {
  CAMERA_STATUSES,
  can,
  cameraVisibility,
  decryptStreamKey,
  encryptStreamKey,
  generateStreamKey,
  hashStreamKey,
  mediaPathForKey,
  parseEncryptionKey,
  streamKeyPrefix,
} from "@topcam/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { db, effectiveTenant, paged, scheduleReconcile, wakeWorker } from "../lib/ctx.js";
import { badRequest, conflict, notFound, pagination, parseBody, uuid } from "../lib/http.js";

const listQuery = pagination.extend({
  tenantId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
  groupId: z.string().uuid().optional(),
  status: z.enum(CAMERA_STATUSES).optional(),
  search: z.string().trim().max(100).optional(),
});

const baseBody = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  locationId: z.string().uuid(),
  groupId: z.string().uuid().nullable().optional(),
  recordingEnabled: z.boolean().default(false),
  retentionPolicyId: z.string().uuid().nullable().optional(),
});

const createBody = baseBody.extend({ tenantId: z.string().uuid() });
const patchBody = baseBody.partial().extend({ enabled: z.boolean().optional() });

const CAMERA_SELECT = `
  SELECT c.id, c.code, c.name, c.description, c.tenant_id AS "tenantId", t.name AS "tenantName",
         c.location_id AS "locationId", l.name AS "locationName",
         c.group_id AS "groupId", g.name AS "groupName",
         c.ingest_protocol AS "ingestProtocol", c.status, c.status_reason AS "statusReason",
         c.status_changed_at AS "statusChangedAt", c.last_video_at AS "lastVideoAt",
         c.last_durable_segment_at AS "lastDurableSegmentAt", c.last_publish_at AS "lastPublishAt",
         c.video_codec AS "videoCodec", c.audio_codec AS "audioCodec", c.width, c.height,
         c.fps::float8 AS fps, c.bitrate_kbps AS "bitrateKbps",
         c.recording_enabled AS "recordingEnabled", c.recording_mode AS "recordingMode",
         c.retention_policy_id AS "retentionPolicyId", rp.name AS "retentionPolicyName",
         rp.retention_hours AS "retentionHours",
         c.enabled, c.stream_key_prefix AS "streamKeyPrefix", c.stream_key_rotated_at AS "streamKeyRotatedAt",
         c.created_at AS "createdAt"
    FROM cameras c
    JOIN tenants t ON t.id = c.tenant_id
    JOIN locations l ON l.id = c.location_id
    LEFT JOIN camera_groups g ON g.id = c.group_id
    LEFT JOIN retention_policies rp ON rp.id = c.retention_policy_id`;

export async function cameraRoutes(app: FastifyInstance): Promise<void> {
  const { env } = app.deps;
  const encKey = parseEncryptionKey(env.STREAM_KEY_ENC_KEY);
  const read = { preHandler: app.requirePermission("cameras.read") };
  const write = { preHandler: app.requirePermission("cameras.write") };
  const keys = { preHandler: app.requirePermission("cameras.keys") };
  const serverUrl = `rtmp://${env.PUBLIC_HOST}:${env.RTMP_PUBLIC_PORT}/live`;

  /** Filtro de visibilidade: operador/visualizador só vê câmeras concedidas. */
  function visibility(req: FastifyRequest): { granted: boolean; userId: string } {
    return { granted: cameraVisibility(req.user!.role) === "granted", userId: req.user!.id };
  }

  /** Remove a chave de quem não pode vê-la. */
  function present(req: FastifyRequest, row: Record<string, unknown>) {
    if (!can(req.user!.role, "cameras.keys")) {
      const { streamKeyPrefix: _p, streamKeyRotatedAt: _r, ...rest } = row;
      return rest;
    }
    return row;
  }

  async function loadCamera(c: PoolClient, req: FastifyRequest, id: string, lock = false) {
    const v = visibility(req);
    const row = (
      await c.query(
        `${CAMERA_SELECT}
          WHERE c.id = $1 AND c.deleted_at IS NULL
            AND ($2::boolean = false OR EXISTS (SELECT 1 FROM user_camera_permissions p
                  WHERE p.camera_id = c.id AND p.user_id = $3))
          ${lock ? "FOR UPDATE OF c" : ""}`,
        [id, v.granted, v.userId],
      )
    ).rows[0];
    if (!row) throw notFound("Câmera não encontrada");
    return row as Record<string, unknown> & {
      id: string;
      tenantId: string;
      code: string;
      enabled: boolean;
    };
  }

  async function validatePlacement(
    c: PoolClient,
    tenantId: string,
    locationId: string,
    groupId: string | null | undefined,
  ) {
    const loc = await c.query(
      "SELECT 1 FROM locations WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL",
      [locationId, tenantId],
    );
    if (!loc.rowCount) throw badRequest("Local inválido para este cliente");
    if (groupId) {
      const g = await c.query(
        "SELECT 1 FROM camera_groups WHERE id = $1 AND location_id = $2 AND deleted_at IS NULL",
        [groupId, locationId],
      );
      if (!g.rowCount) throw badRequest("Grupo inválido para este local");
    }
  }

  async function resolveRetention(c: PoolClient, recording: boolean, requested?: string | null) {
    if (!recording) return requested ?? null;
    if (requested) return requested;
    const def = await c.query<{ id: string }>(
      "SELECT id FROM retention_policies WHERE tenant_id IS NULL ORDER BY retention_hours LIMIT 1",
    );
    return def.rows[0]?.id ?? null;
  }

  // ------------------------------------------------------------------ leitura
  app.get("/api/v1/cameras", read, async (req) => {
    const q = parseBody(listQuery, req.query);
    const tenant = effectiveTenant(req, q.tenantId ?? null);
    const v = visibility(req);
    const rows = await db(
      app,
      req,
      async (c) =>
        (
          await c.query(
            `${CAMERA_SELECT.replace("SELECT c.id", "SELECT count(*) OVER() AS total, c.id")}
            WHERE c.deleted_at IS NULL
              AND ($1::uuid IS NULL OR c.tenant_id = $1)
              AND ($2::uuid IS NULL OR c.location_id = $2)
              AND ($3::uuid IS NULL OR c.group_id = $3)
              AND ($4::text IS NULL OR c.status = $4)
              AND ($5::text IS NULL OR c.name ILIKE '%' || $5 || '%' OR c.code ILIKE '%' || $5 || '%')
              AND ($6::boolean = false OR EXISTS (SELECT 1 FROM user_camera_permissions p
                    WHERE p.camera_id = c.id AND p.user_id = $7))
            ORDER BY t.name, c.code
            LIMIT $8 OFFSET $9`,
            [
              tenant,
              q.locationId ?? null,
              q.groupId ?? null,
              q.status ?? null,
              q.search ?? null,
              v.granted,
              v.userId,
              q.pageSize,
              (q.page - 1) * q.pageSize,
            ],
          )
        ).rows,
    );
    const p = paged(rows, q.page, q.pageSize);
    return { ...p, items: p.items.map((r) => present(req, r)) };
  });

  app.get<{ Params: { id: string } }>("/api/v1/cameras/:id", read, async (req) => {
    const id = parseBody(uuid, req.params.id);
    return db(app, req, async (c) => present(req, await loadCamera(c, req, id)));
  });

  // ------------------------------------------------------------------ cadastro individual
  app.post("/api/v1/cameras", write, async (req, reply) => {
    const b = parseBody(createBody, req.body);
    effectiveTenant(req, b.tenantId);
    const key = generateStreamKey();
    const created = await db(app, req, async (c) => {
      const t = (
        await c.query<{ status: string; max_cameras: number; n: number }>(
          `SELECT t.status, p.max_cameras,
                  (SELECT count(*)::int FROM cameras c WHERE c.tenant_id = t.id AND c.deleted_at IS NULL) AS n
             FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = $1 AND t.deleted_at IS NULL`,
          [b.tenantId],
        )
      ).rows[0];
      if (!t) throw badRequest("Cliente inexistente");
      if (t.n >= t.max_cameras) {
        throw conflict(`Limite do plano atingido (${t.max_cameras} câmeras).`, "plan_limit");
      }
      await validatePlacement(c, b.tenantId, b.locationId, b.groupId);
      const retention = await resolveRetention(c, b.recordingEnabled, b.retentionPolicyId);
      if (b.recordingEnabled && !retention) throw badRequest("Defina uma política de retenção");
      const code = await nextCameraCode(c, b.tenantId);
      const ingest = await c.query<{ id: string }>(
        "SELECT id FROM ingest_nodes ORDER BY created_at LIMIT 1",
      );
      const storage = await c.query<{ id: string }>(
        "SELECT id FROM storage_nodes ORDER BY created_at LIMIT 1",
      );
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO cameras (tenant_id, location_id, group_id, code, name, description, stream_key_hash,
                              stream_key_enc, stream_key_prefix, stream_key_rotated_at, recording_enabled,
                              retention_policy_id, ingest_node_id, storage_node_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10, $11, $12, $13) RETURNING id`,
        [
          b.tenantId,
          b.locationId,
          b.groupId ?? null,
          code,
          b.name,
          b.description ?? null,
          hashStreamKey(key),
          encryptStreamKey(key, encKey),
          streamKeyPrefix(key),
          b.recordingEnabled,
          retention,
          ingest.rows[0]?.id ?? null,
          storage.rows[0]?.id ?? null,
        ],
      );
      const id = rows[0]!.id;
      await audit(c, req, "camera.created", {
        tenantId: b.tenantId,
        entityType: "camera",
        entityId: id,
        data: { code, name: b.name, recording: b.recordingEnabled },
      });
      await scheduleReconcile(c, "camera_created");
      return loadCamera(c, req, id);
    });
    await wakeWorker(app);
    return reply.code(201).send({
      camera: present(req, created),
      // A chave só é devolvida aqui para quem pode vê-la (equipe da plataforma).
      ...(can(req.user!.role, "cameras.keys")
        ? { ingest: { server: serverUrl, streamKey: key, url: `${serverUrl}/${key}` } }
        : {}),
    });
  });

  app.patch<{ Params: { id: string } }>("/api/v1/cameras/:id", write, async (req) => {
    const id = parseBody(uuid, req.params.id);
    const b = parseBody(patchBody, req.body);
    const result = await db(app, req, async (c) => {
      const cur = await loadCamera(c, req, id, true);
      const locationId = b.locationId ?? (cur.locationId as string);
      const groupId = b.groupId !== undefined ? b.groupId : (cur.groupId as string | null);
      if (b.locationId || b.groupId !== undefined)
        await validatePlacement(c, cur.tenantId, locationId, groupId);
      const recording = b.recordingEnabled ?? (cur.recordingEnabled as boolean);
      const retention = await resolveRetention(
        c,
        recording,
        b.retentionPolicyId !== undefined
          ? b.retentionPolicyId
          : (cur.retentionPolicyId as string | null),
      );
      await c.query(
        `UPDATE cameras SET name = COALESCE($2, name),
                description = CASE WHEN $3::boolean THEN $4 ELSE description END,
                location_id = $5, group_id = $6, recording_enabled = $7, retention_policy_id = $8,
                enabled = COALESCE($9, enabled)
          WHERE id = $1`,
        [
          id,
          b.name ?? null,
          b.description !== undefined,
          b.description ?? null,
          locationId,
          groupId,
          recording,
          retention,
          b.enabled ?? null,
        ],
      );
      if (b.enabled === false && cur.enabled)
        await transitionCamera(c, id, "disabled", "disabled_by_user");
      if (b.enabled === true && !cur.enabled)
        await transitionCamera(c, id, "enabled", "enabled_by_user");
      const action =
        b.enabled === false && cur.enabled
          ? "camera.disabled"
          : b.enabled === true && !cur.enabled
            ? "camera.enabled"
            : "camera.updated";
      await audit(c, req, action, {
        tenantId: cur.tenantId,
        entityType: "camera",
        entityId: id,
        data: { code: cur.code, changes: b },
      });
      await scheduleReconcile(c, "camera_updated");
      return loadCamera(c, req, id);
    });
    await wakeWorker(app);
    return present(req, result);
  });

  app.delete<{ Params: { id: string } }>("/api/v1/cameras/:id", write, async (req) => {
    const id = parseBody(uuid, req.params.id);
    await db(app, req, async (c) => {
      const cur = await loadCamera(c, req, id, true);
      await c.query(
        `UPDATE cameras SET deleted_at = now(), enabled = false,
                code = code || '-X' || to_char(now(), 'YYYYMMDDHH24MISS') WHERE id = $1`,
        [id],
      );
      await transitionCamera(c, id, "disabled", "deleted");
      await c.query("DELETE FROM user_camera_permissions WHERE camera_id = $1", [id]);
      await audit(c, req, "camera.deleted", {
        tenantId: cur.tenantId,
        entityType: "camera",
        entityId: id,
        data: { code: cur.code, name: cur.name },
      });
      await scheduleReconcile(c, "camera_deleted");
    });
    await wakeWorker(app);
    return { ok: true };
  });

  // ------------------------------------------------------------------ chave RTMP
  app.get<{ Params: { id: string } }>("/api/v1/cameras/:id/stream-key", keys, async (req) => {
    const id = parseBody(uuid, req.params.id);
    return db(app, req, async (c) => {
      const cur = await loadCamera(c, req, id);
      const enc = (
        await c.query<{ stream_key_enc: string }>(
          "SELECT stream_key_enc FROM cameras WHERE id = $1",
          [id],
        )
      ).rows[0]?.stream_key_enc;
      if (!enc) throw notFound("Câmera sem chave RTMP");
      const key = decryptStreamKey(enc, encKey);
      await audit(c, req, "camera.stream_key_viewed", {
        tenantId: cur.tenantId,
        entityType: "camera",
        entityId: id,
        data: { code: cur.code },
      });
      return {
        server: serverUrl,
        streamKey: key,
        url: `${serverUrl}/${key}`,
        path: mediaPathForKey(key),
      };
    });
  });

  app.post<{ Params: { id: string } }>("/api/v1/cameras/:id/rotate-key", keys, async (req) => {
    const id = parseBody(uuid, req.params.id);
    const key = await db(app, req, async (c) => {
      const cur = await loadCamera(c, req, id, true);
      const k = await rotateStreamKey(c, id, encKey);
      await audit(c, req, "camera.stream_key_rotated", {
        tenantId: cur.tenantId,
        entityType: "camera",
        entityId: id,
        data: { code: cur.code, new_prefix: streamKeyPrefix(k) },
      });
      await insertCameraEvent(c, {
        tenantId: cur.tenantId,
        cameraId: id,
        type: "key_rotated",
        severity: "warning",
        message: `Chave de transmissão de ${cur.code} foi trocada; a chave anterior deixou de valer`,
      });
      return k;
    });
    await wakeWorker(app);
    return { server: serverUrl, streamKey: key, url: `${serverUrl}/${key}` };
  });
}
