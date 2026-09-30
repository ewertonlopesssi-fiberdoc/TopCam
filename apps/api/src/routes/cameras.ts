import {
  insertCameraEvent,
  nextCameraCode,
  reapplyRetention,
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

/** Transferência para outro cliente: destino, local/grupo no destino e o que fazer com a chave. */
const transferBody = z.object({
  tenantId: z.string().uuid(),
  locationId: z.string().uuid(),
  groupId: z.string().uuid().nullable().optional(),
  /** true (padrão): o mesmo equipamento continua transmitindo sem reconfigurar. */
  keepKey: z.boolean().default(true),
});
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
  const revealKey = {
    preHandler: [app.requirePermission("cameras.keys"), app.rateLimit("stream-key", 60, 600)],
  };
  const rotateKey = {
    preHandler: [app.requirePermission("cameras.keys"), app.rateLimit("rotate-key", 30, 600)],
  };
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

  /**
   * Resumo por cliente (tela Câmeras agrupada): total, no ar, gravando e offline de cada
   * cliente, e quantas câmeras atendem aos filtros (pesquisa, status, local, grupo).
   * Com filtros, só vêm os clientes que têm resultado.
   */
  app.get("/api/v1/cameras/summary", read, async (req) => {
    const q = parseBody(listQuery.omit({ page: true, pageSize: true }), req.query);
    const tenant = effectiveTenant(req, q.tenantId ?? null);
    const v = visibility(req);
    const filtered = Boolean(q.search || q.status || q.locationId || q.groupId);
    const rows = await db(
      app,
      req,
      async (c) =>
        (
          await c.query(
            `SELECT t.id AS "tenantId", t.name AS "tenantName", t.status AS "tenantStatus",
                    count(c.id)::int AS total,
                    count(c.id) FILTER (WHERE c.status IN ('recebendo', 'validando', 'ao_vivo', 'gravando'))::int AS online,
                    count(c.id) FILTER (WHERE c.status = 'gravando')::int AS recording,
                    count(c.id) FILTER (WHERE c.status IN ('offline', 'erro'))::int AS offline,
                    count(c.id) FILTER (WHERE
                          ($2::uuid IS NULL OR c.location_id = $2)
                      AND ($3::uuid IS NULL OR c.group_id = $3)
                      AND ($4::text IS NULL OR c.status = $4)
                      AND ($5::text IS NULL OR c.name ILIKE '%' || $5 || '%' OR c.code ILIKE '%' || $5 || '%')
                    )::int AS matching
               FROM tenants t
               JOIN cameras c ON c.tenant_id = t.id AND c.deleted_at IS NULL
              WHERE t.deleted_at IS NULL
                AND ($1::uuid IS NULL OR t.id = $1)
                AND ($6::boolean = false OR EXISTS (SELECT 1 FROM user_camera_permissions p
                      WHERE p.camera_id = c.id AND p.user_id = $7))
              GROUP BY t.id, t.name, t.status
              ORDER BY t.name`,
            [
              tenant,
              q.locationId ?? null,
              q.groupId ?? null,
              q.status ?? null,
              q.search ?? null,
              v.granted,
              v.userId,
            ],
          )
        ).rows as Array<{ matching: number }>,
    );
    return { filtered, items: filtered ? rows.filter((r) => r.matching > 0) : rows };
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
      // Retenção alterada: a validade das gravações já feitas acompanha a nova regra.
      if (retention && retention !== cur.retentionPolicyId) await reapplyRetention(c, id);
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
  app.get<{ Params: { id: string } }>("/api/v1/cameras/:id/stream-key", revealKey, async (req) => {
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

  app.post<{ Params: { id: string } }>("/api/v1/cameras/:id/rotate-key", rotateKey, async (req) => {
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

  // ------------------------------------------------------------------ transferência
  /**
   * Transfere a câmera para outro cliente (só a equipe da plataforma).
   * A câmera antiga é retirada do cliente de origem com o histórico dele (gravações,
   * eventos, alertas, exportações e relatórios ficam na origem e seguem a retenção);
   * uma câmera nova é criada no destino, com o próximo código, a mesma configuração
   * e — por padrão — a mesma chave RTMP (o equipamento não precisa ser reconfigurado).
   * Tudo numa transação: ou transfere, ou nada muda.
   */
  app.post<{ Params: { id: string } }>("/api/v1/cameras/:id/transfer", keys, async (req, reply) => {
    const id = parseBody(uuid, req.params.id);
    const b = parseBody(transferBody, req.body);
    const freshKey = b.keepKey ? null : generateStreamKey();
    const result = await db(app, req, async (c) => {
      const cur = await loadCamera(c, req, id, true);
      if (cur.tenantId === b.tenantId) throw badRequest("A câmera já pertence a este cliente");
      const old = (
        await c.query<{
          name: string;
          description: string | null;
          stream_key_hash: string;
          stream_key_enc: string;
          stream_key_prefix: string;
          recording_enabled: boolean;
          retention_policy_id: string | null;
          retention_tenant: string | null;
          ingest_node_id: string | null;
          storage_node_id: string | null;
          tenant_name: string;
        }>(
          `SELECT c.name, c.description, c.stream_key_hash, c.stream_key_enc, c.stream_key_prefix,
                  c.recording_enabled, c.retention_policy_id, r.tenant_id AS retention_tenant,
                  c.ingest_node_id, c.storage_node_id, t.name AS tenant_name
             FROM cameras c JOIN tenants t ON t.id = c.tenant_id
             LEFT JOIN retention_policies r ON r.id = c.retention_policy_id
            WHERE c.id = $1`,
          [id],
        )
      ).rows[0]!;
      const t = (
        await c.query<{ name: string; max_cameras: number; n: number }>(
          `SELECT t.name, p.max_cameras,
                  (SELECT count(*)::int FROM cameras c WHERE c.tenant_id = t.id AND c.deleted_at IS NULL) AS n
             FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = $1 AND t.deleted_at IS NULL`,
          [b.tenantId],
        )
      ).rows[0];
      if (!t) throw badRequest("Cliente de destino inexistente");
      if (t.n >= t.max_cameras)
        throw conflict(
          `Limite do plano do cliente de destino atingido (${t.max_cameras} câmeras).`,
          "plan_limit",
        );
      await validatePlacement(c, b.tenantId, b.locationId, b.groupId);
      // Política de retenção própria do cliente de origem não vale no destino: usa a padrão.
      const retention =
        old.retention_tenant && old.retention_tenant !== b.tenantId
          ? await resolveRetention(c, old.recording_enabled, null)
          : old.retention_policy_id;

      // 1. Retira a câmera da origem. A chave dela é substituída por uma inutilizada
      //    (a coluna é única e a chave real vai para a câmera nova, se mantida).
      const dead = generateStreamKey();
      await c.query(
        `UPDATE cameras SET deleted_at = now(), enabled = false,
                code = code || '-T' || to_char(now(), 'YYYYMMDDHH24MISS'),
                stream_key_hash = $2, stream_key_enc = $3, stream_key_prefix = $4
          WHERE id = $1`,
        [id, hashStreamKey(dead), encryptStreamKey(dead, encKey), streamKeyPrefix(dead)],
      );
      await transitionCamera(c, id, "disabled", "transferred");
      await c.query("DELETE FROM user_camera_permissions WHERE camera_id = $1", [id]);

      // 2. Cria no destino.
      const code = await nextCameraCode(c, b.tenantId);
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
          old.name,
          old.description,
          freshKey ? hashStreamKey(freshKey) : old.stream_key_hash,
          freshKey ? encryptStreamKey(freshKey, encKey) : old.stream_key_enc,
          freshKey ? streamKeyPrefix(freshKey) : old.stream_key_prefix,
          old.recording_enabled,
          old.recording_enabled ? retention : null,
          old.ingest_node_id,
          old.storage_node_id,
        ],
      );
      const newId = rows[0]!.id;
      const data = {
        from: { tenant: old.tenant_name, code: cur.code, cameraId: id },
        to: { tenant: t.name, code, cameraId: newId },
        keptKey: b.keepKey,
      };
      await audit(c, req, "camera.transferred_out", {
        tenantId: cur.tenantId,
        entityType: "camera",
        entityId: id,
        data,
      });
      await audit(c, req, "camera.transferred_in", {
        tenantId: b.tenantId,
        entityType: "camera",
        entityId: newId,
        data,
      });
      await scheduleReconcile(c, "camera_transferred");
      return loadCamera(c, req, newId);
    });
    await wakeWorker(app);
    return reply.code(201).send({
      camera: present(req, result),
      ...(freshKey
        ? { ingest: { server: serverUrl, streamKey: freshKey, url: `${serverUrl}/${freshKey}` } }
        : {}),
    });
  });
}
