import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, rm, rmdir, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  PLATFORM,
  claimExpiredSegments,
  enqueueJob,
  getSegment,
  insertCameraEvent,
  markSegmentState,
  markSegmentVerified,
  transitionCamera,
  upsertSegmentStart,
  withScope,
  type JobRow,
} from "@topcam/db";
import { CAMERA_PREFIX, parseSegmentPath } from "@topcam/shared";
import type { WorkerContext } from "../context.js";
import { probeFile, type FileProbe } from "../lib/ffprobe.js";

/**
 * Gravação (Fase 4) — o worker é quem confia no disco:
 *
 *  segment.verify   confere um segmento: existe, tem tamanho, SHA-256 e mídia
 *                   válida (ffprobe, com vídeo). Só então vira "verified" e conta
 *                   para o estado "gravando".
 *  scanRecordings   varredura periódica da pasta: indexa arquivos que os hooks
 *                   não informaram (API fora do ar, reinício do MediaMTX), manda
 *                   conferir segmentos que ficaram em "writing" e marca como
 *                   "missing" os que sumiram do disco.
 *  applyRetention   apaga os segmentos vencidos (expires_at) do disco e do índice.
 */

/** Segmento é considerado fechado se o arquivo não muda há este tempo. */
const IDLE_FILE_MS = 90_000;

function absPath(ctx: WorkerContext, relPath: string): string {
  const root = resolve(ctx.env.RECORDINGS_PATH);
  const abs = resolve(root, relPath);
  // Nunca sair da raiz das gravações (defesa contra caminhos adulterados no banco).
  if (!abs.startsWith(root + sep))
    throw new Error(`caminho fora da raiz das gravações: ${relPath}`);
  return abs;
}

async function sha256(file: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest("hex");
}

// ------------------------------------------------------------------ conferência
export async function verifySegmentJob(ctx: WorkerContext, job: JobRow): Promise<void> {
  const id = String((job.payload as { segmentId?: string | number }).segmentId ?? "");
  const seg = await withScope(ctx.pool, PLATFORM, (c) => getSegment(c, id));
  if (!seg || !["writing", "corrupt", "missing"].includes(seg.state)) return;
  const file = absPath(ctx, seg.path);

  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    await withScope(ctx.pool, PLATFORM, async (c) => {
      await markSegmentState(c, seg.id, "missing");
      await insertCameraEvent(c, {
        tenantId: seg.tenant_id,
        cameraId: seg.camera_id,
        type: "segment_missing",
        severity: "error",
        message: "Segmento de gravação não encontrado no disco",
        data: { segment_id: seg.id, path: seg.path },
      });
    });
    return;
  }

  let probe: FileProbe = { durationS: null, streams: [] };
  let probeError = "";
  try {
    probe = await (ctx.probeFile ?? probeFile)(file);
  } catch (err) {
    if ((err as { transient?: boolean }).transient) throw err; // nova tentativa depois
    probeError = (err as Error).message.slice(0, 300);
  }
  const video = probe.streams.find((s) => s.codec_type === "video");
  const audio = probe.streams.find((s) => s.codec_type === "audio");
  if (size === 0 || !video || !probe.durationS) {
    await withScope(ctx.pool, PLATFORM, async (c) => {
      await markSegmentState(c, seg.id, "corrupt");
      await insertCameraEvent(c, {
        tenantId: seg.tenant_id,
        cameraId: seg.camera_id,
        type: "segment_corrupt",
        severity: "error",
        message: "Segmento de gravação inválido (sem vídeo legível)",
        data: {
          segment_id: seg.id,
          path: seg.path,
          size_bytes: size,
          error: probeError || undefined,
        },
      });
    });
    return;
  }

  const checksum = await sha256(file);
  const res = await withScope(ctx.pool, PLATFORM, (c) =>
    markSegmentVerified(c, seg.id, {
      durationMs: Math.round(probe.durationS! * 1000),
      sizeBytes: size,
      checksum,
      videoCodec: video.codec_name ?? null,
      audioCodec: audio?.codec_name ?? null,
    }),
  );
  if (res?.recordingStarted) ctx.log.info({ camera: seg.camera_id }, "câmera gravando");
}

// ------------------------------------------------------------------ varredura
export interface ScanReport {
  files: number;
  indexed: number;
  queued: number;
  missing: number;
  unexpected: number;
}

export async function scanRecordings(ctx: WorkerContext, now = Date.now()): Promise<ScanReport> {
  const report: ScanReport = { files: 0, indexed: 0, queued: 0, missing: 0, unexpected: 0 };
  const root = resolve(ctx.env.RECORDINGS_PATH);
  const camRoot = join(root, CAMERA_PREFIX);
  let dirs: string[];
  try {
    dirs = await readdir(camRoot);
  } catch {
    dirs = [];
  }

  // Arquivos no disco
  const onDisk = new Map<string, { mtimeMs: number; cameraId: string }>();
  for (const d of dirs) {
    let files: string[];
    try {
      files = await readdir(join(camRoot, d));
    } catch {
      continue;
    }
    for (const f of files) {
      const rel = `${CAMERA_PREFIX}${d}/${f}`;
      const info = parseSegmentPath(rel);
      if (!info) continue;
      try {
        onDisk.set(rel, {
          mtimeMs: (await stat(join(camRoot, d, f))).mtimeMs,
          cameraId: info.cameraId,
        });
      } catch {
        /* apagado durante a varredura */
      }
    }
  }
  report.files = onDisk.size;

  await withScope(ctx.pool, PLATFORM, async (c) => {
    const known = new Map(
      (
        await c.query<{
          id: string;
          path: string;
          state: string;
          created_at: Date;
          ended_at: Date | null;
        }>(
          `SELECT id, path, state, created_at, ended_at FROM recording_segments
            WHERE state IN ('writing', 'verified', 'corrupt', 'missing')`,
        )
      ).rows.map((r) => [r.path, r]),
    );
    const cams = new Map(
      (
        await c.query<{ id: string; tenant_id: string; code: string; recording_enabled: boolean }>(
          "SELECT id, tenant_id, code, recording_enabled FROM cameras",
        )
      ).rows.map((r) => [r.id, r]),
    );

    const warnedUnexpected = new Set<string>();
    for (const [rel, f] of onDisk) {
      const cam = cams.get(f.cameraId);
      if (!cam) continue; // pasta de câmera desconhecida: não mexer
      let row = known.get(rel);
      if (!row) {
        const info = parseSegmentPath(rel)!;
        const up = await upsertSegmentStart(c, info);
        if (!up) continue;
        report.indexed++;
        row = {
          id: up.segment.id,
          path: rel,
          state: "writing",
          created_at: new Date(now),
          ended_at: null,
        };
        if (!cam.recording_enabled && !warnedUnexpected.has(cam.id)) {
          warnedUnexpected.add(cam.id);
          report.unexpected++;
          await insertCameraEvent(c, {
            tenantId: cam.tenant_id,
            cameraId: cam.id,
            type: "unexpected_recording",
            severity: "warning",
            message: `Arquivo de gravação encontrado para ${cam.code}, que não está configurada para gravar`,
            data: { path: rel },
          });
        }
      }
      // Arquivo parado há 90 s e ainda "writing": o hook de fim não chegou.
      if (row.state === "writing" && now - f.mtimeMs > IDLE_FILE_MS) {
        if (
          await enqueueJob(
            c,
            "segment.verify",
            { segmentId: row.id },
            { dedupKey: `segment:${row.id}`, maxAttempts: 5 },
          )
        )
          report.queued++;
      }
    }

    // Linhas cujo arquivo sumiu (e que não estão sendo escritas agora).
    for (const [rel, row] of known) {
      if (onDisk.has(rel) || row.state === "missing") continue;
      if (row.state === "writing" && now - row.created_at.getTime() < IDLE_FILE_MS) continue;
      await markSegmentState(c, row.id, "missing");
      report.missing++;
      const seg = await getSegment(c, row.id);
      if (seg)
        await insertCameraEvent(c, {
          tenantId: seg.tenant_id,
          cameraId: seg.camera_id,
          type: "segment_missing",
          severity: "error",
          message: "Segmento de gravação não encontrado no disco",
          data: { segment_id: row.id, path: rel },
        });
    }
  });
  return report;
}

// ------------------------------------------------------------------ retenção
export async function applyRetention(
  ctx: WorkerContext,
): Promise<{ deleted: number; bytes: number }> {
  let deleted = 0;
  let bytes = 0;
  let failed = false;
  for (;;) {
    const batch = await withScope(ctx.pool, PLATFORM, (c) => claimExpiredSegments(c, 200));
    if (!batch.length) break;
    for (const seg of batch) {
      let file: string;
      try {
        file = absPath(ctx, seg.path);
      } catch (err) {
        // Caminho fora da raiz: nunca toca no disco; só limpa o índice.
        ctx.log.error(
          { segment: seg.id, err: (err as Error).message },
          "segmento com caminho inválido",
        );
        await withScope(ctx.pool, PLATFORM, (c) => markSegmentState(c, seg.id, "deleted"));
        continue;
      }
      try {
        await rm(file, { force: true });
        bytes += Number(seg.size_bytes ?? 0);
        deleted++;
        await withScope(ctx.pool, PLATFORM, (c) => markSegmentState(c, seg.id, "deleted"));
      } catch (err) {
        // Continua em "deleting": a próxima rodada tenta de novo (claim só pega os outros estados).
        failed = true;
        ctx.log.error({ segment: seg.id, err: (err as Error).message }, "falha ao apagar segmento");
        await withScope(ctx.pool, PLATFORM, (c) =>
          c.query("UPDATE recording_segments SET state = 'verified' WHERE id = $1", [seg.id]),
        );
      }
      // Remove a pasta da câmera se ficou vazia.
      await rmdir(file.slice(0, file.lastIndexOf(sep))).catch(() => undefined);
    }
    if (batch.length < 200 || failed) break;
  }
  if (deleted) ctx.log.info({ deleted, bytes }, "retenção: segmentos vencidos apagados");
  return { deleted, bytes };
}

// ------------------------------------------------------------------ saúde da gravação
/**
 * Câmera que deveria estar gravando e não tem segmento conferido recente:
 *  - "gravando" sem segmento há RECORDING_STALL_S → volta a "ao vivo" + alerta;
 *  - "ao vivo" com gravação esperada e nenhum segmento no mesmo prazo → alerta
 *    (um por câmera a cada 30 min).
 * Câmera cuja gravação foi desligada (painel, gravação global ou disco) sai de
 * "gravando" na hora.
 */
export async function checkRecordingHealth(
  ctx: WorkerContext,
): Promise<{ stalled: number; stopped: number }> {
  const stallS = ctx.env.RECORDING_STALL_S;
  return withScope(ctx.pool, PLATFORM, async (c) => {
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
      status: string;
      should_record: boolean;
      stale: boolean;
      warned: boolean;
    }>(
      `SELECT c.id, c.tenant_id, c.code, c.status,
              (c.recording_enabled AND $1::boolean AND coalesce(s.recording_blocked, false) = false) AS should_record,
              (coalesce(c.last_durable_segment_at, 'epoch') < now() - make_interval(secs => $2)
                 AND c.status_changed_at < now() - make_interval(secs => $2)) AS stale,
              EXISTS (SELECT 1 FROM camera_events e WHERE e.camera_id = c.id AND e.type = 'recording_stalled'
                        AND e.occurred_at > now() - interval '30 minutes') AS warned
         FROM cameras c LEFT JOIN storage_nodes s ON s.id = c.storage_node_id
        WHERE c.deleted_at IS NULL AND c.status IN ('ao_vivo', 'gravando')`,
      [global, stallS],
    );
    let stalled = 0;
    let stopped = 0;
    for (const r of rows) {
      if (r.status === "gravando" && !r.should_record) {
        const t = await transitionCamera(c, r.id, "recording_stopped", "recording_disabled");
        if (t?.changed) {
          stopped++;
          await insertCameraEvent(c, {
            tenantId: r.tenant_id,
            cameraId: r.id,
            type: "recording_stopped",
            message: `Gravação de ${r.code} desligada`,
            data: { reason: "recording_disabled" },
          });
        }
        continue;
      }
      if (!r.should_record || !r.stale) continue;
      if (r.status === "gravando")
        await transitionCamera(c, r.id, "recording_stopped", "recording_stalled");
      if (r.warned) continue;
      stalled++;
      await insertCameraEvent(c, {
        tenantId: r.tenant_id,
        cameraId: r.id,
        type: "recording_stalled",
        severity: "error",
        message: `${r.code} está ao vivo, mas nenhum segmento de gravação foi confirmado há mais de ${Math.round(stallS / 60)} min`,
        data: { stall_seconds: stallS },
      });
    }
    return { stalled, stopped };
  });
}
