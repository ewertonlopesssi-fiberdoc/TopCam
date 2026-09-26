import {
  PLATFORM,
  insertCameraEvent,
  transitionCamera,
  withScope,
  type CameraRow,
  type JobRow,
} from "@topcam/db";
import { cameraMediaPath, redact, type ProbeStream, type WorkerContext } from "../context.js";
import { parseFrameRate } from "../lib/ffprobe.js";

/** Codecs de vídeo aceitos. H.265 é aceito, mas com aviso de compatibilidade no navegador. */
const SUPPORTED_VIDEO = new Set(["h264", "hevc"]);

export interface ProbeSummary {
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  profile: string | null;
}

export function summarizeProbe(streams: ProbeStream[]): ProbeSummary {
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  return {
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    fps: parseFrameRate(video?.avg_frame_rate) ?? parseFrameRate(video?.r_frame_rate),
    profile: video?.profile ?? null,
  };
}

/**
 * Valida o stream recebido (estado "validando") e, se estiver ok, leva a câmera
 * a "ao_vivo", gravando codec, resolução e fps detectados.
 */
export async function probeJob(ctx: WorkerContext, job: JobRow): Promise<void> {
  const cameraId = String(job.payload.cameraId ?? "");
  const camera = await withScope(ctx.pool, PLATFORM, async (c) => {
    const { rows } = await c.query<CameraRow>(
      `SELECT c.*, t.slug AS tenant_slug, t.status AS tenant_status, NULL::boolean AS storage_blocked
         FROM cameras c JOIN tenants t ON t.id = c.tenant_id WHERE c.id = $1`,
      [cameraId],
    );
    return rows[0] ?? null;
  });
  if (!camera) return;
  if (camera.status !== "recebendo" && camera.status !== "validando") {
    ctx.log.debug({ camera: camera.code, status: camera.status }, "probe ignorado: estado mudou");
    return;
  }
  const path = cameraMediaPath(camera, ctx.encKey);
  if (!path) return;

  await withScope(ctx.pool, PLATFORM, (c) => transitionCamera(c, camera.id, "probe_started"));

  const { env } = ctx;
  const url = `${env.MEDIAMTX_RTSP_URL.replace("rtsp://", `rtsp://${encodeURIComponent(env.MEDIA_READ_USER)}:${encodeURIComponent(env.MEDIA_READ_PASSWORD)}@`)}/${path}`;

  let summary: ProbeSummary;
  try {
    const out = await ctx.runProbe(url, env.PROBE_TIMEOUT_S);
    summary = summarizeProbe(out.streams ?? []);
  } catch (err) {
    const message = redact((err as Error).message);
    // Se o stream caiu durante a validação, não é falha de validação.
    const still = await ctx.mediamtx.getPath(path).catch(() => null);
    if (!still?.ready) {
      ctx.log.info({ camera: camera.code }, "stream caiu durante a validação");
      return;
    }
    if (job.attempts < job.max_attempts) throw new Error(message, { cause: err });
    await failValidation(
      ctx,
      camera,
      "probe_error",
      `Não foi possível validar o vídeo de ${camera.code}: ${message}`,
    );
    return;
  }

  if (!summary.videoCodec) {
    await failValidation(ctx, camera, "no_video", `${camera.code} não enviou faixa de vídeo`);
    return;
  }
  if (!SUPPORTED_VIDEO.has(summary.videoCodec)) {
    await failValidation(
      ctx,
      camera,
      "codec_unsupported",
      `${camera.code} enviou codec de vídeo não suportado (${summary.videoCodec}); use H.264`,
      summary,
    );
    return;
  }

  const videoCodec = summary.videoCodec;
  await withScope(ctx.pool, PLATFORM, async (c) => {
    await c.query(
      `UPDATE cameras SET video_codec = $2, audio_codec = $3, width = $4, height = $5, fps = $6
        WHERE id = $1`,
      [
        camera.id,
        summary.videoCodec,
        summary.audioCodec,
        summary.width,
        summary.height,
        summary.fps,
      ],
    );
    const t = await transitionCamera(c, camera.id, "probe_succeeded");
    await insertCameraEvent(c, {
      tenantId: camera.tenant_id,
      cameraId: camera.id,
      type: "codec_detected",
      message: `${camera.code} validada: ${videoCodec.toUpperCase()} ${summary.width}x${summary.height} @ ${summary.fps ?? "?"} fps${summary.audioCodec ? `, áudio ${summary.audioCodec}` : ", sem áudio"}`,
      data: { ...summary, from: t?.from, to: t?.to },
    });
    if (summary.videoCodec === "hevc") {
      await insertCameraEvent(c, {
        tenantId: camera.tenant_id,
        cameraId: camera.id,
        type: "codec_warning",
        severity: "warning",
        message: `${camera.code} usa H.265: a reprodução pode não funcionar em alguns navegadores (Firefox); H.264 é o recomendado`,
      });
    }
    if (summary.audioCodec && !["aac", "opus"].includes(summary.audioCodec)) {
      await insertCameraEvent(c, {
        tenantId: camera.tenant_id,
        cameraId: camera.id,
        type: "codec_warning",
        severity: "warning",
        message: `${camera.code} usa áudio ${summary.audioCodec}, que o navegador não reproduz; prefira AAC ou desative o áudio`,
      });
    }
  });
  ctx.log.info({ camera: camera.code, ...summary }, "câmera validada");
}

async function failValidation(
  ctx: WorkerContext,
  camera: CameraRow,
  reason: string,
  message: string,
  summary?: ProbeSummary,
): Promise<void> {
  await withScope(ctx.pool, PLATFORM, async (c) => {
    const t = await transitionCamera(c, camera.id, "probe_failed", reason);
    await insertCameraEvent(c, {
      tenantId: camera.tenant_id,
      cameraId: camera.id,
      type: "probe_failed",
      severity: "error",
      message,
      data: { reason, ...(summary ?? {}), from: t?.from, to: t?.to },
    });
  });
  ctx.log.warn({ camera: camera.code, reason }, "validação falhou");
}
