import { PLATFORM, liveAccessAllowed, withScope, type PoolClient } from "@topcam/db";
import {
  GRANTED_VISIBILITY_ROLES,
  cameraVisibility,
  parseLivePath,
  safeEqual,
  signLiveToken,
  verifyLiveToken,
} from "@topcam/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { db } from "../lib/ctx.js";
import { parseBody } from "../lib/http.js";
import type { AuthUser } from "../plugins/auth.js";

/**
 * Ao vivo (Fase 3).
 *
 *  POST /api/v1/live/sessions        { cameraIds: [...] } → endereços temporários (mosaico)
 *  POST /api/v1/cameras/:id/live     → endereço temporário de uma câmera
 *  GET  /internal/live/auth          → forward_auth do gateway para cada pedido /live/<token>/...
 *
 * O navegador nunca recebe a chave RTMP nem o caminho interno (cam/<id>): só um
 * token assinado que vale para um usuário, uma sessão e uma câmera.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sessionsBody = z.object({
  cameraIds: z.array(z.string().uuid()).min(1).max(16),
});

interface LiveCamera {
  id: string;
  code: string;
  name: string;
  tenantId: string;
  tenantName: string;
  tenantStatus: string;
  status: string;
  enabled: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  lastVideoAt: string | null;
  granted: boolean;
}

const LIVE_SELECT = `
  SELECT c.id, c.code, c.name, c.tenant_id AS "tenantId", t.name AS "tenantName",
         t.status AS "tenantStatus", c.status, c.enabled, c.video_codec AS "videoCodec",
         c.audio_codec AS "audioCodec", c.width, c.height, c.fps::float8 AS fps,
         c.last_video_at AS "lastVideoAt",
         EXISTS (SELECT 1 FROM user_camera_permissions p
                  WHERE p.camera_id = c.id AND p.user_id = $2 AND p.can_live) AS granted
    FROM cameras c JOIN tenants t ON t.id = c.tenant_id
   WHERE c.id = ANY($1::uuid[]) AND c.deleted_at IS NULL`;

async function loadLiveCameras(c: PoolClient, ids: string[], userId: string) {
  return (await c.query<LiveCamera>(LIVE_SELECT, [ids, userId])).rows;
}

/** Motivo pelo qual o usuário não pode ver a câmera ao vivo (null = pode). */
function refusal(
  user: AuthUser,
  cam: LiveCamera | undefined,
): { code: string; message: string } | null {
  if (!cam) return { code: "not_found", message: "Câmera não encontrada" };
  if (cameraVisibility(user.role) === "granted" && !cam.granted)
    return { code: "not_found", message: "Câmera não encontrada" };
  if (!cam.enabled) return { code: "camera_disabled", message: "Câmera desabilitada" };
  if (cam.tenantStatus !== "active")
    return { code: "tenant_inactive", message: "Cliente suspenso ou cancelado" };
  return null;
}

/** Avisos de compatibilidade do navegador (D2). */
function warnings(cam: LiveCamera): string[] {
  const w: string[] = [];
  const v = (cam.videoCodec ?? "").toLowerCase();
  if (v && v !== "h264")
    w.push(
      v === "h265" || v === "hevc"
        ? "Vídeo H.265: toca no Safari e no Chrome/Edge com aceleração por hardware; não toca no Firefox. Para máxima compatibilidade, configure a câmera em H.264."
        : `Codec de vídeo ${cam.videoCodec} pode não tocar no navegador.`,
    );
  const a = (cam.audioCodec ?? "").toLowerCase();
  if (a && !["aac", "mpeg-4 audio", "opus"].includes(a))
    w.push(`Áudio ${cam.audioCodec} não toca no navegador; o vídeo é exibido sem som.`);
  return w;
}

export async function liveRoutes(app: FastifyInstance): Promise<void> {
  const { env, pool, redis } = app.deps;
  const read = { preHandler: app.requirePermission("cameras.read") };

  async function issue(req: FastifyRequest, ids: string[]) {
    const user = req.user!;
    const cams = await db(app, req, (c) => loadLiveCameras(c, ids, user.id));
    const byId = new Map(cams.map((c) => [c.id, c]));
    const exp = Math.floor(Date.now() / 1000) + env.LIVE_TOKEN_TTL_S;
    const expiresAt = new Date(exp * 1000).toISOString();
    const items = [];
    const viewed: LiveCamera[] = [];
    for (const id of ids) {
      const cam = byId.get(id);
      const no = refusal(user, cam);
      if (no) {
        items.push({ cameraId: id, ok: false, error: no.code, message: no.message });
        continue;
      }
      const token = signLiveToken(env.JWT_SECRET, { c: id, u: user.id, s: user.sessionId, e: exp });
      items.push({
        cameraId: id,
        ok: true,
        code: cam!.code,
        name: cam!.name,
        tenantName: cam!.tenantName,
        status: cam!.status,
        videoCodec: cam!.videoCodec,
        audioCodec: cam!.audioCodec,
        width: cam!.width,
        height: cam!.height,
        fps: cam!.fps,
        lastVideoAt: cam!.lastVideoAt,
        // "cookieCheck=1": o MediaMTX leva a sessão HLS na query dos endereços seguintes
        // (sem cookies; o gateway não repassa cookies do servidor de mídia ao navegador).
        hls: `/live/${token}/index.m3u8?cookieCheck=1`,
        whep: `/live/${token}/whep?t=${token}`,
        expiresAt,
        warnings: warnings(cam!),
      });
      viewed.push(cam!);
    }
    // Auditoria de quem abriu o ao vivo: um registro por usuário e câmera a cada 30 min.
    const toAudit: LiveCamera[] = [];
    for (const cam of viewed) {
      const first = await redis
        .set(`topcam:live:audit:${user.id}:${cam.id}`, "1", "EX", 1800, "NX")
        .catch(() => "OK");
      if (first) toAudit.push(cam);
    }
    if (toAudit.length)
      await db(app, req, async (c) => {
        for (const cam of toAudit)
          await audit(c, req, "camera.live_viewed", {
            tenantId: cam.tenantId,
            entityType: "camera",
            entityId: cam.id,
            data: { code: cam.code },
          });
      });
    return items;
  }

  app.post("/api/v1/live/sessions", read, async (req) => {
    const { cameraIds } = parseBody(sessionsBody, req.body);
    return { items: await issue(req, [...new Set(cameraIds)]) };
  });

  app.post<{ Params: { id: string } }>("/api/v1/cameras/:id/live", read, async (req, reply) => {
    const id = req.params.id;
    if (!UUID.test(id))
      return reply.code(404).send({ error: "not_found", message: "Câmera não encontrada" });
    const [item] = await issue(req, [id]);
    if (!item!.ok) {
      const status = item!.error === "not_found" ? 404 : 409;
      return reply.code(status).send({ error: item!.error, message: item!.message });
    }
    return item;
  });

  // ------------------------------------------------------------------ forward_auth do gateway
  const cache = new Map<string, { until: number; path: string; kind: string }>();
  const METHODS: Record<"hls" | "whep", Set<string>> = {
    hls: new Set(["GET", "HEAD"]),
    whep: new Set(["POST", "PATCH", "DELETE"]),
  };

  function deny(reply: FastifyReply, code: number, reason: string) {
    return reply.code(code).header("cache-control", "no-store").send({ error: reason });
  }

  app.get("/internal/live/auth", async (req, reply) => {
    const secret = (req.query as Record<string, string | undefined>).secret ?? "";
    if (!safeEqual(secret, env.MEDIA_HOOK_SECRET)) return deny(reply, 403, "forbidden");

    const uri = String(req.headers["x-forwarded-uri"] ?? "");
    const method = String(req.headers["x-forwarded-method"] ?? "GET").toUpperCase();
    const parsed = parseLivePath(uri);
    if (!parsed) return deny(reply, 404, "not_found");
    if (!METHODS[parsed.kind].has(method)) return deny(reply, 405, "method_not_allowed");

    const now = Date.now();
    const hit = cache.get(parsed.token);
    let cameraId: string;
    if (hit && hit.until > now) {
      cameraId = hit.path;
    } else {
      const v = verifyLiveToken(env.JWT_SECRET, parsed.token);
      if (!v.ok) return deny(reply, 403, v.reason);
      const { claims } = v;
      // Token de reprodução ou de exportação não vale para o ao vivo.
      if (claims.k) return deny(reply, 403, "wrong_kind");
      // WHEP: a oferta precisa trazer o próprio token na query (t=). O MediaMTX guarda a
      // query da sessão WebRTC, e o worker usa o token para encerrar sessões cuja
      // permissão foi revogada (a mídia WebRTC não passa mais pelo gateway).
      if (parsed.kind === "whep" && method === "POST") {
        if (new URLSearchParams(parsed.query).get("t") !== parsed.token)
          return deny(reply, 400, "missing_session_ref");
      }
      const ok = await withScope(pool, PLATFORM, (c) =>
        liveAccessAllowed(c, {
          userId: claims.u,
          sessionId: claims.s,
          cameraId: claims.c,
          grantedRoles: GRANTED_VISIBILITY_ROLES,
        }),
      );
      const allowed = ok ? claims.c : null;
      if (!allowed) {
        cache.delete(parsed.token);
        return deny(reply, 403, "revoked");
      }
      cameraId = allowed;
      if (env.LIVE_AUTH_CACHE_S > 0) {
        if (cache.size > 5000) cache.clear();
        cache.set(parsed.token, {
          until: now + env.LIVE_AUTH_CACHE_S * 1000,
          path: cameraId,
          kind: parsed.kind,
        });
      }
    }
    return reply
      .code(200)
      .header("cache-control", "no-store")
      .header("x-media-path", `/cam/${cameraId}/${parsed.rest}`)
      .header("x-media-kind", parsed.kind)
      .send();
  });
}
