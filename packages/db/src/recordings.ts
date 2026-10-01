import { MOTION_HOLD_MIN } from "@topcam/shared";
import type { PoolClient } from "./pool.js";
import { insertCameraEvent, transitionCamera } from "./repo.js";

/**
 * Índice de gravações (recording_segments).
 *
 * Ciclo de um segmento:
 *   writing  → criado quando o MediaMTX abre o arquivo (hook) ou pela varredura
 *   verified → o worker conferiu o arquivo (tamanho, SHA-256, ffprobe com vídeo)
 *   corrupt  → arquivo existe mas não é mídia válida
 *   missing  → arquivo sumiu antes de vencer
 *   deleting → retenção venceu, apagando
 *   deleted  → apagado (a linha fica por 30 dias para auditoria)
 *
 * O caminho é relativo à raiz das gravações (cam/<id>/<início>.mp4): a mesma
 * linha vale em outro servidor, só muda o mount_path do storage_node.
 */

/** Diferença mínima entre dois segmentos para registrar uma lacuna. */
export const GAP_THRESHOLD_MS = 3000;

export interface SegmentRow {
  id: string;
  tenant_id: string;
  camera_id: string;
  path: string;
  started_at: Date;
  ended_at: Date | null;
  duration_ms: number | null;
  state: string;
  expires_at: Date;
  created_at: Date;
  size_bytes: string | null;
}

const SEGMENT_COLS = `id, tenant_id, camera_id, path, started_at, ended_at, duration_ms, state,
  expires_at, created_at, size_bytes`;

/**
 * Registra o início de um segmento (idempotente pelo caminho). A validade vem da
 * política de retenção da câmera (24 h se não houver). Retorna null se a câmera
 * não existir.
 */
export async function upsertSegmentStart(
  client: PoolClient,
  s: { cameraId: string; relPath: string; startedAt: Date },
): Promise<{ segment: SegmentRow; inserted: boolean } | null> {
  const { rows } = await client.query<SegmentRow & { inserted: boolean }>(
    // Gravação só com movimento: o segmento nasce em espera, com validade curta
    // (keepMotionSegments estende os que encostam num movimento).
    `INSERT INTO recording_segments (tenant_id, camera_id, storage_node_id, path, started_at, expires_at,
                                     motion_hold)
     SELECT c.tenant_id, c.id,
            coalesce(c.storage_node_id, (SELECT id FROM storage_nodes ORDER BY created_at LIMIT 1)),
            $2, $3::timestamptz,
            CASE WHEN c.recording_mode = 'motion'
                 THEN $3::timestamptz + make_interval(mins => $4)
                 ELSE $3::timestamptz + make_interval(hours => coalesce(rp.retention_hours, 24)) END,
            c.recording_mode = 'motion'
       FROM cameras c
       LEFT JOIN retention_policies rp ON rp.id = c.retention_policy_id
      WHERE c.id = $1
     ON CONFLICT (path) DO UPDATE SET path = EXCLUDED.path
     RETURNING ${SEGMENT_COLS}, (xmax = 0) AS inserted`,
    [s.cameraId, s.relPath, s.startedAt, MOTION_HOLD_MIN],
  );
  const r = rows[0];
  if (!r) return null;
  const { inserted, ...segment } = r;
  return { segment, inserted };
}

/** Registra o fim informado pelo MediaMTX (a duração definitiva vem da conferência). */
export async function markSegmentComplete(
  client: PoolClient,
  relPath: string,
  durationMs: number | null,
): Promise<SegmentRow | null> {
  const { rows } = await client.query<SegmentRow>(
    `UPDATE recording_segments
        SET duration_ms = coalesce($2, duration_ms),
            ended_at = CASE WHEN $2::int IS NULL THEN ended_at
                            ELSE started_at + make_interval(secs => $2::int / 1000.0) END
      WHERE path = $1 AND state = 'writing'
      RETURNING ${SEGMENT_COLS}`,
    [relPath, durationMs],
  );
  return rows[0] ?? null;
}

export async function getSegment(client: PoolClient, id: string): Promise<SegmentRow | null> {
  const { rows } = await client.query<SegmentRow>(
    `SELECT ${SEGMENT_COLS} FROM recording_segments WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export interface VerifiedInfo {
  durationMs: number;
  sizeBytes: number;
  checksum: string;
  videoCodec: string | null;
  audioCodec: string | null;
}

/**
 * Marca o segmento como conferido, atualiza last_durable_segment_at e, se a
 * câmera estiver ao vivo, passa para "gravando" (primeiro segmento durável).
 * Também registra lacunas em relação aos segmentos vizinhos.
 */
export async function markSegmentVerified(
  client: PoolClient,
  id: string,
  info: VerifiedInfo,
): Promise<{ segment: SegmentRow; recordingStarted: boolean; gaps: number } | null> {
  const { rows } = await client.query<SegmentRow>(
    `UPDATE recording_segments
        SET state = 'verified', verified_at = now(), duration_ms = $2,
            ended_at = started_at + make_interval(secs => $2::int / 1000.0),
            size_bytes = $3, checksum_sha256 = $4, video_codec = $5, audio_codec = $6
      WHERE id = $1 AND state IN ('writing', 'corrupt', 'missing')
      RETURNING ${SEGMENT_COLS}`,
    [id, info.durationMs, info.sizeBytes, info.checksum, info.videoCodec, info.audioCodec],
  );
  const seg = rows[0];
  if (!seg) return null;
  const cam = (
    await client.query<{ code: string; recording_enabled: boolean }>(
      `UPDATE cameras SET last_durable_segment_at = greatest(coalesce(last_durable_segment_at, $2), $2)
        WHERE id = $1 RETURNING code, recording_enabled`,
      [seg.camera_id, seg.ended_at],
    )
  ).rows[0]!;

  // "gravando" só depois de um segmento durável, e só se ainda estiver gravando
  // agora (um segmento antigo conferido depois não religa o estado).
  let recordingStarted = false;
  if (cam.recording_enabled && seg.ended_at && Date.now() - seg.ended_at.getTime() < 5 * 60_000) {
    const t = await transitionCamera(client, seg.camera_id, "first_segment_verified");
    if (t?.changed) {
      recordingStarted = true;
      await insertCameraEvent(client, {
        tenantId: seg.tenant_id,
        cameraId: seg.camera_id,
        type: "recording_started",
        message: `${cam.code} está gravando (primeiro segmento conferido)`,
        data: { segment_id: seg.id, from: t.from, to: t.to },
      });
    }
  }
  const gaps = await recordGaps(client, seg, cam.code);
  return { segment: seg, recordingStarted, gaps };
}

/**
 * Lacunas entre este segmento e os vizinhos (evento único por par de segmentos). Trechos
 * apagados por falta de movimento contam como vizinhos: não são falha de sinal.
 */
async function recordGaps(client: PoolClient, seg: SegmentRow, code: string): Promise<number> {
  const neighbours = await client.query<SegmentRow & { side: string }>(
    `(SELECT ${SEGMENT_COLS}, 'prev' AS side FROM recording_segments
       WHERE camera_id = $1 AND started_at < $2 AND id <> $3
         AND (state <> 'deleted' OR deleted_reason = 'no_motion')
       ORDER BY started_at DESC LIMIT 1)
     UNION ALL
     (SELECT ${SEGMENT_COLS}, 'next' AS side FROM recording_segments
       WHERE camera_id = $1 AND started_at > $2 AND id <> $3
         AND (state <> 'deleted' OR deleted_reason = 'no_motion')
       ORDER BY started_at LIMIT 1)`,
    [seg.camera_id, seg.started_at, seg.id],
  );
  let n = 0;
  for (const nb of neighbours.rows) {
    const [a, b] = nb.side === "prev" ? [nb, seg] : [seg, nb];
    if (!a.ended_at) continue; // fim ainda desconhecido: a conferência do outro segmento decide
    const gapMs = b.started_at.getTime() - a.ended_at.getTime();
    if (gapMs <= GAP_THRESHOLD_MS) continue;
    const dup = await client.query(
      `SELECT 1 FROM camera_events WHERE camera_id = $1 AND type = 'recording_gap'
          AND data->>'before_segment' = $2 AND data->>'after_segment' = $3`,
      [seg.camera_id, String(a.id), String(b.id)],
    );
    if (dup.rowCount) continue;
    await insertCameraEvent(client, {
      tenantId: seg.tenant_id,
      cameraId: seg.camera_id,
      type: "recording_gap",
      severity: "warning",
      message: `Lacuna de ${Math.round(gapMs / 1000)} s na gravação de ${code}`,
      data: {
        before_segment: String(a.id),
        after_segment: String(b.id),
        gap_from: a.ended_at.toISOString(),
        gap_to: b.started_at.toISOString(),
        gap_seconds: Math.round(gapMs / 100) / 10,
      },
    });
    n++;
  }
  return n;
}

export async function markSegmentState(
  client: PoolClient,
  id: string,
  state: "corrupt" | "missing" | "deleting" | "deleted",
): Promise<void> {
  await client.query(
    `UPDATE recording_segments SET state = $2,
            deleted_at = CASE WHEN $2 = 'deleted' THEN now() ELSE deleted_at END,
            -- Em espera (gravação só com movimento) e vencido: não teve movimento.
            deleted_reason = CASE WHEN $2 = 'deleted'
                                  THEN CASE WHEN motion_hold THEN 'no_motion' ELSE 'retention' END
                                  ELSE deleted_reason END
      WHERE id = $1`,
    [id, state],
  );
}

/** Segmentos vencidos, travados para apagar (outro worker pula os mesmos). */
export async function claimExpiredSegments(client: PoolClient, limit = 500): Promise<SegmentRow[]> {
  const { rows } = await client.query<SegmentRow>(
    `UPDATE recording_segments SET state = 'deleting'
      WHERE id IN (SELECT id FROM recording_segments
                    -- "deleting" também: um worker pode ter parado no meio de uma exclusão.
                    WHERE expires_at <= now()
                      AND state IN ('writing', 'verified', 'corrupt', 'missing', 'deleting')
                    ORDER BY expires_at
                    FOR UPDATE SKIP LOCKED
                    LIMIT $1)
      RETURNING ${SEGMENT_COLS}`,
    [limit],
  );
  return rows;
}

/**
 * Recalcula a validade dos segmentos de uma câmera (retenção alterada). Os em espera da
 * gravação só com movimento mantêm a validade curta.
 */
export async function reapplyRetention(client: PoolClient, cameraId: string): Promise<number> {
  const res = await client.query(
    `UPDATE recording_segments s
        SET expires_at = s.started_at + make_interval(hours => coalesce(rp.retention_hours, 24))
       FROM cameras c LEFT JOIN retention_policies rp ON rp.id = c.retention_policy_id
      WHERE c.id = s.camera_id AND s.camera_id = $1 AND NOT s.motion_hold
        AND s.state IN ('writing', 'verified', 'corrupt', 'missing')`,
    [cameraId],
  );
  return res.rowCount ?? 0;
}

/** Remove do índice as linhas apagadas há mais de 30 dias. */
export async function pruneDeletedSegments(client: PoolClient): Promise<number> {
  const res = await client.query(
    "DELETE FROM recording_segments WHERE state = 'deleted' AND deleted_at < now() - interval '30 days'",
  );
  return res.rowCount ?? 0;
}
