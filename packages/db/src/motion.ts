import {
  MOTION_MERGE_S,
  MOTION_POINT_S,
  MOTION_POST_S,
  MOTION_PRE_S,
  hashSmtpPassword,
  safeEqual,
} from "@topcam/shared";
import type { PoolClient } from "./pool.js";

/**
 * Movimento (eventos), gravação só com movimento e credenciais do receptor de eventos.
 * Sempre chamadas dentro de withScope().
 */

export interface MotionEventRow {
  id: string;
  tenant_id: string;
  camera_id: string;
  source: "camera" | "server";
  kind: string;
  started_at: Date;
  ended_at: Date;
  hits: number;
}

/**
 * Registra um aviso de movimento. Avisos seguidos (até MOTION_MERGE_S depois do fim do
 * último) estendem o mesmo evento em vez de criar outro. `until` é o fim conhecido do
 * movimento (detector do servidor); sem ele, o aviso vale MOTION_POINT_S.
 * Retorna null se a câmera não existe, está excluída ou não usa esta origem.
 */
export async function recordMotionHit(
  client: PoolClient,
  h: {
    cameraId: string;
    source: "camera" | "server";
    kind?: string;
    at: Date;
    until?: Date;
    data?: Record<string, unknown>;
  },
): Promise<{ event: MotionEventRow; created: boolean } | null> {
  const cam = (
    await client.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM cameras
        WHERE id = $1 AND deleted_at IS NULL AND enabled AND motion_source = $2
        FOR UPDATE`,
      [h.cameraId, h.source],
    )
  ).rows[0];
  if (!cam) return null;
  const end = new Date(Math.max(h.until?.getTime() ?? 0, h.at.getTime() + MOTION_POINT_S * 1000));
  const kind = h.kind ?? "motion";
  const last = (
    await client.query<MotionEventRow>(
      `SELECT id::text, tenant_id, camera_id, source, kind, started_at, ended_at, hits
         FROM motion_events
        WHERE camera_id = $1 AND source = $2
          AND ended_at >= $3::timestamptz - make_interval(secs => $4)
          AND started_at <= $5
        ORDER BY ended_at DESC LIMIT 1`,
      [h.cameraId, h.source, h.at, MOTION_MERGE_S, end],
    )
  ).rows[0];
  await client.query(
    "UPDATE cameras SET last_motion_at = greatest(coalesce(last_motion_at, $2), $2) WHERE id = $1",
    [h.cameraId, h.at],
  );
  if (last) {
    // "Pessoa" prevalece sobre "movimento" no mesmo evento.
    const k = last.kind === "human" || kind === "human" ? "human" : last.kind;
    const { rows } = await client.query<MotionEventRow>(
      `UPDATE motion_events
          SET ended_at = greatest(ended_at, $2), started_at = least(started_at, $3),
              hits = hits + 1, kind = $4
        WHERE id = $1
        RETURNING id::text, tenant_id, camera_id, source, kind, started_at, ended_at, hits`,
      [last.id, end, h.at, k],
    );
    return { event: rows[0]!, created: false };
  }
  const { rows } = await client.query<MotionEventRow>(
    `INSERT INTO motion_events (tenant_id, camera_id, source, kind, started_at, ended_at, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id::text, tenant_id, camera_id, source, kind, started_at, ended_at, hits`,
    [cam.tenant_id, h.cameraId, h.source, kind, h.at, end, JSON.stringify(h.data ?? {})],
  );
  return { event: rows[0]!, created: true };
}

/**
 * Gravação só com movimento: os segmentos em espera que encostam num movimento (com a
 * folga antes e depois) passam a valer a retenção normal da câmera. Os demais continuam
 * em espera e são apagados quando a validade curta vence.
 */
export async function keepMotionSegments(client: PoolClient): Promise<number> {
  const res = await client.query(
    `UPDATE recording_segments s
        SET motion_hold = false,
            expires_at = s.started_at + make_interval(hours => coalesce(rp.retention_hours, 24))
       FROM cameras c
       LEFT JOIN retention_policies rp ON rp.id = c.retention_policy_id
      WHERE s.motion_hold
        AND c.id = s.camera_id
        AND s.state IN ('writing', 'verified', 'corrupt', 'missing')
        AND EXISTS (
          SELECT 1 FROM motion_events m
           WHERE m.camera_id = s.camera_id
             AND m.started_at - make_interval(secs => $1) < coalesce(s.ended_at, s.started_at + interval '2 minutes')
             AND m.ended_at + make_interval(secs => $2) > s.started_at)`,
    [MOTION_PRE_S, MOTION_POST_S],
  );
  return res.rowCount ?? 0;
}

/**
 * A câmera deixou a gravação só com movimento (ou a gravação foi desligada): o que estava
 * em espera passa a valer a retenção normal, para não apagar nada de surpresa.
 */
export async function releaseMotionHolds(client: PoolClient, cameraId: string): Promise<number> {
  const res = await client.query(
    `UPDATE recording_segments s
        SET motion_hold = false,
            expires_at = s.started_at + make_interval(hours => coalesce(rp.retention_hours, 24))
       FROM cameras c
       LEFT JOIN retention_policies rp ON rp.id = c.retention_policy_id
      WHERE c.id = s.camera_id AND s.camera_id = $1 AND s.motion_hold
        AND s.state IN ('writing', 'verified', 'corrupt', 'missing')`,
    [cameraId],
  );
  return res.rowCount ?? 0;
}

/** Câmera pela credencial do receptor de eventos (conferência em tempo constante). */
export async function findCameraBySmtpLogin(
  client: PoolClient,
  user: string,
  password: string,
): Promise<{ id: string; tenant_id: string; code: string; motion_source: string } | null> {
  const row = (
    await client.query<{
      id: string;
      tenant_id: string;
      code: string;
      motion_source: string;
      motion_smtp_hash: string;
    }>(
      `SELECT c.id, c.tenant_id, c.code, c.motion_source, c.motion_smtp_hash
         FROM cameras c JOIN tenants t ON t.id = c.tenant_id
        WHERE c.motion_smtp_user = $1 AND c.deleted_at IS NULL AND c.enabled
          AND t.deleted_at IS NULL AND t.status = 'active'`,
      [user],
    )
  ).rows[0];
  const expected = hashSmtpPassword(user, password);
  if (!row?.motion_smtp_hash) {
    safeEqual(expected, expected); // mesmo custo com ou sem usuário
    return null;
  }
  if (!safeEqual(expected, row.motion_smtp_hash)) return null;
  const { motion_smtp_hash: _h, ...cam } = row;
  return cam;
}
