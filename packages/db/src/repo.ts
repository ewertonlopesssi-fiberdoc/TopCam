import {
  encryptStreamKey,
  generateStreamKey,
  hashStreamKey,
  nextCameraStatus,
  streamKeyPrefix,
  type CameraEventType,
  type CameraStateEvent,
  type CameraStatus,
  type EventSeverity,
  type JobType,
} from "@topcam/shared";
import type { PoolClient } from "./pool.js";

/** Operações compartilhadas entre API e worker. Sempre chamadas dentro de withScope(). */

export interface CameraRow {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  status: CameraStatus;
  enabled: boolean;
  deleted_at: Date | null;
  ingest_protocol: string;
  recording_enabled: boolean;
  stream_key_enc: string | null;
  last_video_at: Date | null;
  status_changed_at: Date;
  stream_key_prefix: string | null;
  tenant_slug: string;
  tenant_status: string;
  storage_blocked: boolean | null;
}

const CAMERA_SELECT = `
  SELECT c.id, c.tenant_id, c.code, c.name, c.status, c.enabled, c.deleted_at, c.ingest_protocol,
         c.recording_enabled, c.stream_key_enc, c.last_video_at, c.status_changed_at, c.stream_key_prefix,
         t.slug AS tenant_slug, t.status AS tenant_status, s.recording_blocked AS storage_blocked
    FROM cameras c
    JOIN tenants t ON t.id = c.tenant_id
    LEFT JOIN storage_nodes s ON s.id = c.storage_node_id`;

export async function findCameraByKeyHash(
  client: PoolClient,
  keyHash: string,
): Promise<CameraRow | null> {
  const { rows } = await client.query<CameraRow>(`${CAMERA_SELECT} WHERE c.stream_key_hash = $1`, [
    keyHash,
  ]);
  return rows[0] ?? null;
}

export async function findCameraByCode(
  client: PoolClient,
  tenantSlug: string,
  code: string,
): Promise<CameraRow | null> {
  const { rows } = await client.query<CameraRow>(
    `${CAMERA_SELECT} WHERE t.slug = $1 AND c.code = $2 AND c.deleted_at IS NULL`,
    [tenantSlug, code],
  );
  return rows[0] ?? null;
}

/** Câmeras que devem ter caminho configurado no servidor de mídia. */
export async function listActiveRtmpCameras(client: PoolClient): Promise<CameraRow[]> {
  const { rows } = await client.query<CameraRow>(
    `${CAMERA_SELECT}
      WHERE c.deleted_at IS NULL AND c.enabled AND c.ingest_protocol = 'rtmp_push'
        AND t.status = 'active' AND t.deleted_at IS NULL
      ORDER BY t.slug, c.code`,
  );
  return rows;
}

export interface TransitionResult {
  changed: boolean;
  from: CameraStatus;
  to: CameraStatus;
}

/**
 * Aplica um evento da máquina de estados com bloqueio da linha (SELECT ... FOR
 * UPDATE), evitando corridas entre hooks do MediaMTX e o poller do worker.
 */
export async function transitionCamera(
  client: PoolClient,
  cameraId: string,
  event: CameraStateEvent,
  reason?: string,
): Promise<TransitionResult | null> {
  const { rows } = await client.query<{ status: CameraStatus; last_video_at: Date | null }>(
    "SELECT status, last_video_at FROM cameras WHERE id = $1 FOR UPDATE",
    [cameraId],
  );
  const row = rows[0];
  if (!row) return null;
  const next = nextCameraStatus(row.status, event, { everStreamed: row.last_video_at !== null });
  if (!next || next === row.status) return { changed: false, from: row.status, to: row.status };
  await client.query(
    "UPDATE cameras SET status = $2, status_changed_at = now(), status_reason = $3 WHERE id = $1",
    [cameraId, next, reason ?? event],
  );
  return { changed: true, from: row.status, to: next };
}

export interface NewCameraEvent {
  tenantId: string | null;
  cameraId: string | null;
  type: CameraEventType;
  severity?: EventSeverity;
  message: string;
  data?: Record<string, unknown>;
  sourceIp?: string | null;
}

export async function insertCameraEvent(client: PoolClient, e: NewCameraEvent): Promise<void> {
  await client.query(
    `INSERT INTO camera_events (tenant_id, camera_id, type, severity, message, data, source_ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      e.tenantId,
      e.cameraId,
      e.type,
      e.severity ?? "info",
      e.message,
      JSON.stringify(e.data ?? {}),
      normalizeIp(e.sourceIp),
    ],
  );
}

/** Remove porta e colchetes; retorna null se não parecer um IP. */
export function normalizeIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  let v = ip.trim();
  const bracket = v.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracket) v = bracket[1]!;
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(v)) v = v.replace(/:\d+$/, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v)) return v;
  if (v.includes(":") && /^[0-9a-fA-F:.]+$/.test(v)) return v;
  return null;
}

export async function insertAudit(
  client: PoolClient,
  a: {
    tenantId: string | null;
    actorType: "user" | "system" | "cli";
    actorUserId?: string | null;
    action: string;
    entityType?: string;
    entityId?: string;
    data?: Record<string, unknown>;
    ip?: string | null;
    userAgent?: string | null;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs (tenant_id, actor_user_id, actor_type, action, entity_type, entity_id, data, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      a.tenantId,
      a.actorUserId ?? null,
      a.actorType,
      a.action,
      a.entityType ?? null,
      a.entityId ?? null,
      JSON.stringify(a.data ?? {}),
      normalizeIp(a.ip),
      a.userAgent ? a.userAgent.slice(0, 300) : null,
    ],
  );
}

/**
 * Gera e grava uma nova chave RTMP para a câmera (a anterior deixa de valer),
 * encerra o estado de transmissão e agenda a reconciliação do servidor de mídia,
 * que desconecta quem ainda usa a chave antiga. Retorna a chave nova em claro.
 */
export async function rotateStreamKey(
  client: PoolClient,
  cameraId: string,
  encKey: Buffer,
): Promise<string> {
  const key = generateStreamKey();
  await client.query(
    `UPDATE cameras SET stream_key_hash = $2, stream_key_enc = $3, stream_key_prefix = $4,
            stream_key_rotated_at = now() WHERE id = $1`,
    [cameraId, hashStreamKey(key), encryptStreamKey(key, encKey), streamKeyPrefix(key)],
  );
  await transitionCamera(client, cameraId, "stream_offline", "key_rotated");
  await enqueueJob(
    client,
    "mediamtx.reconcile",
    { reason: "key_rotated" },
    { dedupKey: "reconcile" },
  );
  return key;
}

/** Próximo código CAM-### do cliente (bloqueia o cliente para evitar códigos repetidos). */
export async function nextCameraCode(client: PoolClient, tenantId: string): Promise<string> {
  await client.query("SELECT 1 FROM tenants WHERE id = $1 FOR UPDATE", [tenantId]);
  const { rows } = await client.query<{ n: number | null }>(
    `SELECT max(substring(code FROM '^CAM-([0-9]+)$')::int) AS n FROM cameras WHERE tenant_id = $1`,
    [tenantId],
  );
  const n = (rows[0]?.n ?? 0) + 1;
  return `CAM-${String(n).padStart(3, "0")}`;
}

// ------------------------------------------------------------------ tarefas duráveis

export interface JobRow {
  id: string;
  type: JobType;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export async function enqueueJob(
  client: PoolClient,
  type: JobType,
  payload: Record<string, unknown>,
  opts: { dedupKey?: string; delaySeconds?: number; maxAttempts?: number } = {},
): Promise<boolean> {
  const res = await client.query(
    `INSERT INTO durable_jobs (type, payload, dedup_key, run_at, max_attempts)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4), $5)
     ON CONFLICT (dedup_key) WHERE status IN ('pending', 'running') DO NOTHING`,
    [
      type,
      JSON.stringify(payload),
      opts.dedupKey ?? null,
      opts.delaySeconds ?? 0,
      opts.maxAttempts ?? 5,
    ],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function claimJob(client: PoolClient, workerId: string): Promise<JobRow | null> {
  const { rows } = await client.query<JobRow>(
    `UPDATE durable_jobs
        SET status = 'running', locked_at = now(), locked_by = $1, attempts = attempts + 1
      WHERE id = (SELECT id FROM durable_jobs
                   WHERE status = 'pending' AND run_at <= now()
                   ORDER BY run_at, id
                   FOR UPDATE SKIP LOCKED
                   LIMIT 1)
      RETURNING id, type, payload, attempts, max_attempts`,
    [workerId],
  );
  return rows[0] ?? null;
}

export async function completeJob(client: PoolClient, id: string): Promise<void> {
  await client.query(
    "UPDATE durable_jobs SET status = 'done', locked_at = NULL, last_error = NULL WHERE id = $1",
    [id],
  );
}

export async function failJob(client: PoolClient, job: JobRow, error: string): Promise<void> {
  const final = job.attempts >= job.max_attempts;
  await client.query(
    `UPDATE durable_jobs
        SET status = $2, locked_at = NULL, last_error = $3,
            run_at = now() + make_interval(secs => $4)
      WHERE id = $1`,
    [job.id, final ? "failed" : "pending", error.slice(0, 2000), Math.min(60, 2 ** job.attempts)],
  );
}

/** Devolve à fila tarefas presas em 'running' (worker reiniciado no meio). */
export async function recoverStaleJobs(
  client: PoolClient,
  olderThanSeconds = 300,
): Promise<number> {
  const res = await client.query(
    `UPDATE durable_jobs SET status = 'pending', locked_at = NULL, locked_by = NULL
      WHERE status = 'running' AND locked_at < now() - make_interval(secs => $1)`,
    [olderThanSeconds],
  );
  return res.rowCount ?? 0;
}

/** Limpa tarefas concluídas antigas (mantém 7 dias para diagnóstico). */
export async function pruneJobs(client: PoolClient): Promise<void> {
  await client.query(
    "DELETE FROM durable_jobs WHERE status IN ('done', 'failed') AND updated_at < now() - interval '7 days'",
  );
}

export async function getSetting<T>(client: PoolClient, key: string, fallback: T): Promise<T> {
  const { rows } = await client.query<{ value: T }>(
    "SELECT value FROM system_settings WHERE key = $1",
    [key],
  );
  return rows[0] ? rows[0].value : fallback;
}

/**
 * O usuário (nesta sessão) ainda pode ver a câmera ao vivo? Mesma regra usada ao
 * emitir o endereço temporário: usuário ativo sem troca de senha pendente, sessão
 * não encerrada, cliente do usuário e da câmera ativos, câmera habilitada e — para
 * papéis com visibilidade por concessão — permissão "ao vivo" na câmera.
 * Usada pelo gateway (a cada pedido HLS/WHEP) e pelo worker (sessões WebRTC abertas).
 */
export async function liveAccessAllowed(
  client: PoolClient,
  a: {
    userId: string;
    sessionId: string;
    cameraId: string;
    grantedRoles: readonly string[];
    /** Direito exigido de quem vê só câmeras concedidas (padrão: ao vivo). */
    right?: "live" | "playback" | "export";
  },
): Promise<boolean> {
  const column = { live: "p.can_live", playback: "p.can_playback", export: "p.can_export" }[
    a.right ?? "live"
  ];
  const { rowCount } = await client.query(
    `SELECT 1
       FROM users u
       JOIN roles r ON r.id = u.role_id
       JOIN sessions s ON s.id = $2 AND s.user_id = u.id
       LEFT JOIN tenants ut ON ut.id = u.tenant_id
       JOIN cameras c ON c.id = $3 AND c.deleted_at IS NULL AND c.enabled
       JOIN tenants ct ON ct.id = c.tenant_id AND ct.status = 'active'
      WHERE u.id = $1 AND u.status = 'active' AND u.deleted_at IS NULL
        AND NOT u.must_change_password
        AND s.revoked_at IS NULL AND s.expires_at > now()
        AND (u.tenant_id IS NULL OR (ut.status = 'active' AND c.tenant_id = u.tenant_id))
        AND (NOT (r.key = ANY($4::text[])) OR EXISTS (
              SELECT 1 FROM user_camera_permissions p
               WHERE p.user_id = u.id AND p.camera_id = c.id AND ${column}))`,
    [a.userId, a.sessionId, a.cameraId, a.grantedRoles],
  );
  return (rowCount ?? 0) > 0;
}
