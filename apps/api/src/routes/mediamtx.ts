import {
  PLATFORM,
  enqueueJob,
  findCameraByKeyHash,
  insertCameraEvent,
  markSegmentComplete,
  normalizeIp,
  transitionCamera,
  upsertSegmentStart,
  withScope,
  type CameraRow,
} from "@topcam/db";
import {
  JOBS_WAKE_CHANNEL,
  fingerprint,
  hashStreamKey,
  parseMtxDuration,
  parseSegmentPath,
  safeEqual,
  streamKeyFromPath,
} from "@topcam/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

/**
 * Rotas internas chamadas pelo MediaMTX (rede interna; o gateway não as expõe).
 *  - POST /internal/mediamtx/auth          → autenticação HTTP de cada publicação/leitura
 *  - POST /internal/mediamtx/hooks/:event  → runOnOnline / runOnOffline
 */

const authBody = z.object({
  user: z.string().optional().default(""),
  password: z.string().optional().default(""),
  token: z.string().optional().default(""),
  ip: z.string().optional().default(""),
  action: z.string(),
  path: z.string().optional().default(""),
  protocol: z.string().optional().default(""),
  id: z.string().nullable().optional(),
  query: z.string().optional().default(""),
});

const hookBody = z.object({
  path: z.string(),
  source_type: z.string().optional().default(""),
  source_id: z.string().optional().default(""),
});

const segmentBody = z.object({
  path: z.string(),
  segment_path: z.string().min(1),
  segment_duration: z.string().optional().default(""),
});

const PUBLISH_PROTOCOLS = new Set(["rtmp", "rtmps"]);
const CAM_PATH = /^cam\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function mediamtxRoutes(app: FastifyInstance): Promise<void> {
  const { env, pool, redis } = app.deps;

  function checkSecret(req: FastifyRequest, reply: FastifyReply): boolean {
    const secret = (req.query as Record<string, string | undefined>).secret ?? "";
    if (!safeEqual(secret, env.MEDIA_HOOK_SECRET)) {
      void reply.code(403).send({ error: "forbidden" });
      return false;
    }
    return true;
  }

  /** Evita inundar camera_events quando uma câmera insiste com chave errada. */
  async function firstInWindow(key: string, seconds: number): Promise<boolean> {
    try {
      return (await redis.set(`topcam:evt:${key}`, "1", "EX", seconds, "NX")) === "OK";
    } catch {
      return true;
    }
  }

  async function wakeWorker(): Promise<void> {
    try {
      await redis.publish(JOBS_WAKE_CHANNEL, "1");
    } catch (err) {
      app.log.warn({ err }, "falha ao acordar o worker (seguirá por polling)");
    }
  }

  function deny(reply: FastifyReply) {
    return reply.code(401).send({ error: "unauthorized" });
  }

  app.post("/internal/mediamtx/auth", async (req, reply) => {
    if (!checkSecret(req, reply)) return;
    const parsed = authBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
    const body = parsed.data;

    // ------------------------------------------------------------- leitura interna
    if (body.action === "read" || body.action === "playback") {
      // Worker/relay: credencial interna (RTSP), qualquer caminho.
      if (body.user === env.MEDIA_READ_USER && safeEqual(body.password, env.MEDIA_READ_PASSWORD))
        return reply.code(200).send();
      // Gateway do ao vivo: token próprio, só cam/<id> e só HLS/WebRTC. O usuário final já
      // foi autorizado pela API (forward_auth) antes de o gateway chegar aqui.
      if (
        body.action === "read" &&
        body.token &&
        safeEqual(body.token, env.MEDIA_GATEWAY_TOKEN) &&
        CAM_PATH.test(body.path) &&
        (body.protocol === "hls" || body.protocol === "webrtc")
      )
        return reply.code(200).send();
      req.log.warn(
        {
          action: body.action,
          path: body.path.startsWith("live/") ? "live/<chave>" : body.path,
          protocol: body.protocol,
          user: body.user,
          hasToken: Boolean(body.token),
          ip: body.ip,
        },
        "leitura recusada no servidor de mídia",
      );
      return deny(reply);
    }
    if (body.action !== "publish") return deny(reply);

    // ------------------------------------------------------------- publicação
    const key = streamKeyFromPath(body.path);
    if (!key) {
      if (
        await firstInWindow(
          `badpath:${fingerprint(body.path)}:${body.ip}`,
          env.AUTH_REJECT_EVENT_WINDOW_S,
        )
      ) {
        await withScope(pool, PLATFORM, (c) =>
          insertCameraEvent(c, {
            tenantId: null,
            cameraId: null,
            type: "auth_rejected",
            severity: "warning",
            message: "Publicação recusada: caminho fora do padrão live/<chave>",
            data: {
              reason: "invalid_path",
              path_fingerprint: fingerprint(body.path),
              protocol: body.protocol,
            },
            sourceIp: body.ip,
          }),
        );
      }
      return deny(reply);
    }

    const keyHash = hashStreamKey(key);
    const camera = await withScope(pool, PLATFORM, (c) => findCameraByKeyHash(c, keyHash));
    if (!camera) {
      if (
        await firstInWindow(
          `badkey:${keyHash.slice(0, 16)}:${body.ip}`,
          env.AUTH_REJECT_EVENT_WINDOW_S,
        )
      ) {
        await withScope(pool, PLATFORM, (c) =>
          insertCameraEvent(c, {
            tenantId: null,
            cameraId: null,
            type: "auth_rejected",
            severity: "warning",
            message: "Publicação recusada: chave de transmissão inválida",
            data: {
              reason: "unknown_key",
              key_fingerprint: keyHash.slice(0, 12),
              protocol: body.protocol,
            },
            sourceIp: body.ip,
          }),
        );
      }
      req.log.warn(
        { ip: body.ip, fp: keyHash.slice(0, 12) },
        "publicação recusada: chave desconhecida",
      );
      return deny(reply);
    }

    const refusal = publishRefusal(camera, body.protocol);
    if (refusal) {
      if (
        await firstInWindow(`denied:${camera.id}:${refusal.reason}`, env.AUTH_REJECT_EVENT_WINDOW_S)
      ) {
        await withScope(pool, PLATFORM, (c) =>
          insertCameraEvent(c, {
            tenantId: camera.tenant_id,
            cameraId: camera.id,
            type: "publish_denied",
            severity: "warning",
            message: refusal.message,
            data: { reason: refusal.reason, protocol: body.protocol },
            sourceIp: body.ip,
          }),
        );
      }
      return deny(reply);
    }

    // Publicação simultânea indevida: a câmera já tem um publicador ativo.
    // Importante: não consultar a API do MediaMTX aqui — ele aguarda esta
    // resposta para processar a publicação, e a consulta ficaria bloqueada.
    // O estado vem do banco (hooks + poller); overridePublisher: false no
    // MediaMTX é a segunda barreira.
    const alreadyPublishing = hasActivePublisher(camera, env.PUBLISH_ACTIVE_WINDOW_S);
    if (alreadyPublishing) {
      if (await firstInWindow(`dup:${camera.id}:${body.ip}`, 30)) {
        await withScope(pool, PLATFORM, (c) =>
          insertCameraEvent(c, {
            tenantId: camera.tenant_id,
            cameraId: camera.id,
            type: "duplicate_publish_rejected",
            severity: "warning",
            message: `Segunda publicação recusada: ${camera.code} já está transmitindo`,
            data: { protocol: body.protocol },
            sourceIp: body.ip,
          }),
        );
      }
      return deny(reply);
    }

    await withScope(pool, PLATFORM, async (c) => {
      const t = await transitionCamera(c, camera.id, "publish_authorized");
      await c.query(
        "UPDATE cameras SET last_publish_at = now(), last_publish_ip = $2 WHERE id = $1",
        [camera.id, normalizeIp(body.ip)],
      );
      await insertCameraEvent(c, {
        tenantId: camera.tenant_id,
        cameraId: camera.id,
        type: "publish_authorized",
        message: `Publicação autorizada para ${camera.code}`,
        data: { protocol: body.protocol, from: t?.from, to: t?.to },
        sourceIp: body.ip,
      });
    });
    return reply.code(200).send();
  });

  // ------------------------------------------------------------- gravação (Fase 4)
  // Início e fim de cada segmento gravado em cam/<id>. A API só indexa; quem
  // confere o arquivo (tamanho, SHA-256, ffprobe) é o worker (segment.verify).
  app.post<{ Params: { event: string } }>(
    "/internal/mediamtx/hooks/segment_:event",
    async (req, reply) => {
      if (!checkSecret(req, reply)) return;
      const { event } = req.params;
      if (event !== "create" && event !== "complete") return reply.code(404).send();
      const parsed = segmentBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
      const info = parseSegmentPath(parsed.data.segment_path, env.RECORDINGS_PATH);
      if (!info || parsed.data.path !== `cam/${info.cameraId}`) {
        req.log.warn({ path: parsed.data.path }, "segmento fora do padrão cam/<id>/<início>.mp4");
        return reply.code(400).send({ error: "invalid_segment_path" });
      }
      const durationMs = parseMtxDuration(parsed.data.segment_duration);
      const queued = await withScope(pool, PLATFORM, async (c) => {
        const up = await upsertSegmentStart(c, info);
        if (!up) return false;
        if (event === "create") return false;
        await markSegmentComplete(c, info.relPath, durationMs);
        return enqueueJob(
          c,
          "segment.verify",
          { segmentId: up.segment.id },
          { dedupKey: `segment:${up.segment.id}`, maxAttempts: 5 },
        );
      });
      if (queued) await wakeWorker();
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { event: string } }>("/internal/mediamtx/hooks/:event", async (req, reply) => {
    if (!checkSecret(req, reply)) return;
    const { event } = req.params;
    if (event !== "online" && event !== "offline") return reply.code(404).send();
    const parsed = hookBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
    const key = streamKeyFromPath(parsed.data.path);
    if (!key) return reply.code(204).send();

    const handled = await withScope(pool, PLATFORM, async (c) => {
      const camera = await findCameraByKeyHash(c, hashStreamKey(key));
      if (!camera) return false;
      if (event === "online") {
        const t = await transitionCamera(c, camera.id, "stream_online");
        await c.query("UPDATE cameras SET last_video_at = now() WHERE id = $1", [camera.id]);
        await insertCameraEvent(c, {
          tenantId: camera.tenant_id,
          cameraId: camera.id,
          type: "stream_online",
          message: `${camera.code} começou a enviar vídeo`,
          data: { source_type: parsed.data.source_type, from: t?.from, to: t?.to },
        });
        await enqueueJob(
          c,
          "camera.probe",
          { cameraId: camera.id },
          { dedupKey: `probe:${camera.id}`, maxAttempts: 3 },
        );
      } else {
        const t = await transitionCamera(c, camera.id, "stream_offline");
        if (t?.changed) {
          await insertCameraEvent(c, {
            tenantId: camera.tenant_id,
            cameraId: camera.id,
            type: "stream_offline",
            severity: "warning",
            message: `${camera.code} parou de transmitir`,
            data: { source: "hook", from: t.from, to: t.to },
          });
        }
      }
      return true;
    });
    if (handled && event === "online") await wakeWorker();
    return reply.code(204).send();
  });
}

const RECEIVING = new Set(["recebendo", "validando", "ao_vivo", "gravando"]);

/** Publicador ativo: vídeo recente num estado de recepção, ou autorização muito recente. */
export function hasActivePublisher(camera: CameraRow, windowS: number, now = Date.now()): boolean {
  const windowMs = windowS * 1000;
  if (RECEIVING.has(camera.status) && camera.last_video_at) {
    return now - camera.last_video_at.getTime() < windowMs;
  }
  if (camera.status === "conectando") {
    return now - camera.status_changed_at.getTime() < windowMs;
  }
  return false;
}

function publishRefusal(
  camera: CameraRow,
  protocol: string,
): { reason: string; message: string } | null {
  if (camera.deleted_at)
    return { reason: "camera_deleted", message: `Câmera ${camera.code} foi removida` };
  if (!camera.enabled || camera.status === "desabilitada")
    return { reason: "camera_disabled", message: `Câmera ${camera.code} está desabilitada` };
  if (camera.tenant_status !== "active")
    return { reason: "tenant_inactive", message: `Cliente ${camera.tenant_slug} não está ativo` };
  if (camera.ingest_protocol !== "rtmp_push")
    return { reason: "wrong_ingest_protocol", message: `Câmera ${camera.code} não usa RTMP push` };
  if (!PUBLISH_PROTOCOLS.has(protocol))
    return {
      reason: "protocol_not_allowed",
      message: `Protocolo ${protocol || "?"} não permitido para publicação`,
    };
  return null;
}
