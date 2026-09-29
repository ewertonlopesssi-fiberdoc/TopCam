import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { PLATFORM, insertAudit, liveAccessAllowed, withScope } from "@topcam/db";
import {
  GRANTED_VISIBILITY_ROLES,
  safeEqual,
  signLiveToken,
  verifyLiveToken,
  type LiveClaims,
} from "@topcam/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { db } from "../lib/ctx.js";
import { HttpError, badRequest, forbidden, parseBody, uuid } from "../lib/http.js";

/**
 * Reprodução e exportação de gravações (Fase 5).
 *
 *  GET  /api/v1/cameras/:id/recordings/days     dias com gravação (calendário)
 *  POST /api/v1/cameras/:id/playback            endereço temporário de reprodução
 *  GET  /internal/playback/auth                 forward_auth do gateway (/playback/<token>/get)
 *  POST /api/v1/cameras/:id/exports             pede a exportação MP4 de um trecho (auditada)
 *  GET  /api/v1/exports/:token                  baixa o MP4 (link temporário, sem cabeçalho)
 *
 * O vídeo vem do servidor de reprodução do MediaMTX (interno, :9996), que junta os
 * segmentos gravados. O navegador nunca fala com ele diretamente.
 */

type LoadCam = (
  req: FastifyRequest,
  id: string,
) => Promise<{ id: string; code: string; name: string; canExport: boolean }>;

const daysQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tz: z.string().max(64).default("America/Sao_Paulo"),
});

const exportBody = z.object({
  start: z.coerce.date(),
  end: z.coerce.date(),
});

const CAM_PARAM = /^cam\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("pt-BR", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function stamp(d: Date, tz: string): string {
  // AAAA-MM-DD_hh-mm-ss no fuso do usuário (nome do arquivo baixado).
  const p = new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
  return p.replace(" ", "_").replace(/:/g, "-");
}

export async function playbackRoutes(app: FastifyInstance, loadCam: LoadCam): Promise<void> {
  const { env, pool, redis } = app.deps;
  const read = { preHandler: app.requirePermission("cameras.read") };

  // ------------------------------------------------------------------ calendário
  app.get<{ Params: { id: string } }>("/api/v1/cameras/:id/recordings/days", read, async (req) => {
    const id = parseBody(uuid, req.params.id);
    const q = parseBody(daysQuery, req.query);
    if (!validTz(q.tz)) throw badRequest("Fuso horário inválido");
    if (q.to < q.from) throw badRequest("Intervalo inválido");
    await loadCam(req, id);
    const rows = await db(
      app,
      req,
      async (c) =>
        (
          await c.query<{ day: string; seconds: number; segments: number }>(
            `SELECT to_char((started_at AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS day,
                    round(sum(duration_ms) / 1000.0)::int AS seconds, count(*)::int AS segments
               FROM recording_segments
              WHERE camera_id = $1 AND state = 'verified'
                AND (started_at AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date
              GROUP BY 1 ORDER BY 1`,
            [id, q.tz, q.from, q.to],
          )
        ).rows,
    );
    return { items: rows };
  });

  // ------------------------------------------------------------------ reprodução
  app.post<{ Params: { id: string } }>("/api/v1/cameras/:id/playback", read, async (req) => {
    const id = parseBody(uuid, req.params.id);
    const cam = await loadCam(req, id);
    const user = req.user!;
    const exp = Math.floor(Date.now() / 1000) + env.LIVE_TOKEN_TTL_S;
    const token = signLiveToken(env.JWT_SECRET, {
      c: id,
      u: user.id,
      s: user.sessionId,
      e: exp,
      k: "p",
    });
    // Um registro por usuário e câmera a cada 30 min.
    const first = await redis
      .set(`topcam:playback:audit:${user.id}:${id}`, "1", "EX", 1800, "NX")
      .catch(() => "OK");
    if (first)
      await db(app, req, async (c) => {
        const t = await c.query<{ tenant_id: string }>(
          "SELECT tenant_id FROM cameras WHERE id = $1",
          [id],
        );
        await audit(c, req, "camera.playback_viewed", {
          tenantId: t.rows[0]?.tenant_id ?? null,
          entityType: "camera",
          entityId: id,
          data: { code: cam.code },
        });
      });
    return {
      cameraId: id,
      // O cliente acrescenta start (RFC 3339) e duration (s): o gateway exige path=cam/<id>.
      url: `/playback/${token}/get?path=cam/${id}&format=fmp4`,
      expiresAt: new Date(exp * 1000).toISOString(),
      maxDurationS: 3600,
    };
  });

  function deny(reply: FastifyReply, code: number, reason: string) {
    return reply.code(code).header("cache-control", "no-store").send({ error: reason });
  }

  /** O usuário (nesta sessão) ainda tem o direito pedido nesta câmera? */
  async function allowed(claims: LiveClaims, right: "playback" | "export") {
    return withScope(pool, PLATFORM, (c) =>
      liveAccessAllowed(c, {
        userId: claims.u,
        sessionId: claims.s,
        cameraId: claims.c,
        grantedRoles: GRANTED_VISIBILITY_ROLES,
        right,
      }),
    );
  }

  app.get("/internal/playback/auth", async (req, reply) => {
    const secret = (req.query as Record<string, string | undefined>).secret ?? "";
    if (!safeEqual(secret, env.MEDIA_HOOK_SECRET)) return deny(reply, 403, "forbidden");
    const uri = String(req.headers["x-forwarded-uri"] ?? "");
    const method = String(req.headers["x-forwarded-method"] ?? "GET").toUpperCase();
    const m = /^(?:\/playback)?\/([A-Za-z0-9._-]{20,600})\/get\?(.*)$/.exec(uri);
    if (!m) return deny(reply, 403, "bad_path");
    if (method !== "GET" && method !== "HEAD") return deny(reply, 405, "method_not_allowed");
    const v = verifyLiveToken(env.JWT_SECRET, m[1]!);
    if (!v.ok) return deny(reply, 403, v.reason);
    if (v.claims.k !== "p") return deny(reply, 403, "wrong_kind");
    const q = new URLSearchParams(m[2]);
    const path = CAM_PARAM.exec(q.get("path") ?? "");
    // O token vale só para a câmera dele; recusa qualquer outro caminho.
    if (!path || path[1] !== v.claims.c) return deny(reply, 403, "wrong_camera");
    const duration = Number(q.get("duration"));
    if (!q.get("start") || !Number.isFinite(duration) || duration <= 0 || duration > 3600)
      return deny(reply, 400, "bad_range");
    if ((q.get("format") ?? "fmp4") !== "fmp4") return deny(reply, 400, "bad_format");
    if (!(await allowed(v.claims, "playback"))) return deny(reply, 403, "revoked");
    return reply
      .code(200)
      .header("cache-control", "no-store")
      .header("x-media-path", "/get")
      .send();
  });

  // ------------------------------------------------------------------ exportação MP4
  app.post<{ Params: { id: string } }>("/api/v1/cameras/:id/exports", read, async (req) => {
    const id = parseBody(uuid, req.params.id);
    const b = parseBody(exportBody, req.body);
    const cam = await loadCam(req, id);
    if (!cam.canExport)
      throw forbidden("Você não tem permissão para exportar gravações desta câmera");
    const durS = Math.round((b.end.getTime() - b.start.getTime()) / 1000);
    if (durS <= 0) throw badRequest("O fim precisa ser depois do início");
    if (durS > env.EXPORT_MAX_S)
      throw badRequest(`O trecho pode ter no máximo ${Math.round(env.EXPORT_MAX_S / 60)} minutos`);
    if (b.end.getTime() > Date.now() + 5000) throw badRequest("O fim não pode estar no futuro");
    const covered = await db(
      app,
      req,
      async (c) =>
        (
          await c.query<{ ms: number | null; tenant_id: string }>(
            `SELECT sum(extract(epoch FROM (least(ended_at, $3) - greatest(started_at, $2))) * 1000)::bigint AS ms,
                  (SELECT tenant_id FROM cameras WHERE id = $1) AS tenant_id
             FROM recording_segments
            WHERE camera_id = $1 AND state = 'verified' AND ended_at > $2 AND started_at < $3`,
            [id, b.start, b.end],
          )
        ).rows[0]!,
    );
    if (!covered.ms || Number(covered.ms) <= 0)
      throw new HttpError(404, "no_recording", "Não há gravação nesse período");
    const user = req.user!;
    const exp = Math.floor(Date.now() / 1000) + 600;
    const token = signLiveToken(env.JWT_SECRET, {
      c: id,
      u: user.id,
      s: user.sessionId,
      e: exp,
      k: "x",
      a: b.start.getTime(),
      d: durS,
    });
    const filename = `${cam.code}_${stamp(b.start, "America/Sao_Paulo")}_${Math.round(durS / 60)}min.mp4`;
    await db(app, req, (c) =>
      audit(c, req, "camera.export_requested", {
        tenantId: covered.tenant_id,
        entityType: "camera",
        entityId: id,
        data: {
          code: cam.code,
          start: b.start.toISOString(),
          end: b.end.toISOString(),
          seconds: durS,
          recorded_seconds: Math.round(Number(covered.ms) / 1000),
        },
      }),
    );
    return {
      downloadUrl: `/api/v1/exports/${token}`,
      filename,
      expiresAt: new Date(exp * 1000).toISOString(),
      seconds: durS,
      recordedSeconds: Math.round(Number(covered.ms) / 1000),
    };
  });

  app.get<{ Params: { token: string } }>("/api/v1/exports/:token", async (req, reply) => {
    const v = verifyLiveToken(env.JWT_SECRET, req.params.token);
    if (!v.ok || v.claims.k !== "x" || !v.claims.a || !v.claims.d)
      return deny(
        reply,
        v.ok ? 403 : v.reason === "expired" ? 410 : 403,
        v.ok ? "wrong_kind" : v.reason,
      );
    const claims = v.claims;
    if (!(await allowed(claims, "export"))) return deny(reply, 403, "revoked");
    const start = new Date(claims.a!);
    const end = new Date(claims.a! + claims.d! * 1000);
    // O servidor de reprodução para na primeira lacuna: o trecho é pedido bloco a bloco.
    const parts = await continuousParts(claims.c, start, end);
    if (!parts.length) return deny(reply, 404, "no_recording");
    if (parts.length > MAX_EXPORT_PARTS) return deny(reply, 422, "too_many_gaps");
    const partUrl = (p: Part, auth: boolean) =>
      `${auth ? env.MEDIAMTX_PLAYBACK_URL.replace("://", `://${encodeURIComponent(env.MEDIA_READ_USER)}:${encodeURIComponent(env.MEDIA_READ_PASSWORD)}@`) : env.MEDIAMTX_PLAYBACK_URL}` +
      `/get?path=cam/${claims.c}&start=${encodeURIComponent(new Date(p.from.getTime() + START_MARGIN_MS).toISOString())}` +
      `&duration=${Math.max(1, Math.ceil((p.to.getTime() - p.from.getTime() - START_MARGIN_MS) / 1000))}`;
    let body: Readable;
    if (parts.length === 1) {
      const res = await fetch(`${partUrl(parts[0]!, false)}&format=mp4`, {
        headers: {
          authorization: `Basic ${Buffer.from(`${env.MEDIA_READ_USER}:${env.MEDIA_READ_PASSWORD}`).toString("base64")}`,
        },
      }).catch(() => null);
      if (!res || !res.ok || !res.body)
        return deny(
          reply,
          res?.status === 404 ? 404 : 502,
          res?.status === 404 ? "no_recording" : "playback_unavailable",
        );
      body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
    } else {
      // Blocos em MP4 comum (com a duração no cabeçalho), para o ffmpeg emendar os tempos.
      body = concatParts(
        parts.map((p) => `${partUrl(p, true)}&format=mp4`),
        req.log,
      );
    }
    const cam = await withScope(
      pool,
      PLATFORM,
      async (c) =>
        (
          await c.query<{ code: string; tenant_id: string }>(
            "SELECT code, tenant_id FROM cameras WHERE id = $1",
            [claims.c],
          )
        ).rows[0],
    );
    // O link não leva cabeçalho de login: o autor vem do token (usuário que pediu a exportação).
    await withScope(pool, PLATFORM, (c) =>
      insertAudit(c, {
        tenantId: cam?.tenant_id ?? null,
        actorType: "user",
        actorUserId: claims.u,
        action: "camera.exported",
        entityType: "camera",
        entityId: claims.c,
        data: {
          code: cam?.code,
          start: start.toISOString(),
          seconds: claims.d,
          recorded_seconds: Math.round(
            parts.reduce((a, p) => a + p.to.getTime() - p.from.getTime(), 0) / 1000,
          ),
          parts: parts.length,
        },
        ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
      }),
    );
    const filename = `${cam?.code ?? "camera"}_${stamp(start, "America/Sao_Paulo")}_${Math.round(claims.d! / 60)}min.mp4`;
    return reply
      .header("content-type", "video/mp4")
      .header("content-disposition", `attachment; filename="${filename}"`)
      .header("cache-control", "no-store")
      .send(body);
  });

  /** Blocos contínuos (tolerância de 1 s, a mesma do servidor de reprodução) dentro do trecho. */
  async function continuousParts(cameraId: string, from: Date, to: Date): Promise<Part[]> {
    const rows = await withScope(
      pool,
      PLATFORM,
      async (c) =>
        (
          await c.query<{
            s: Date;
            e: Date;
            start: Date;
            holes: Array<{ from: number; to: number }> | null;
          }>(
            `SELECT greatest(started_at, $2) AS s, least(ended_at, $3) AS e, started_at AS start, holes
               FROM recording_segments
              WHERE camera_id = $1 AND state = 'verified' AND ended_at > $2 AND started_at < $3
              ORDER BY started_at`,
            [cameraId, from, to],
          )
        ).rows,
    );
    // Buracos internos (quadros perdidos) dividem o segmento em pedaços.
    const pieces: Array<{ s: Date; e: Date }> = [];
    for (const r of rows) {
      let cur = r.s.getTime();
      for (const h of r.holes ?? []) {
        const hs = r.start.getTime() + h.from * 1000;
        const he = r.start.getTime() + h.to * 1000;
        if (he <= cur || hs >= r.e.getTime()) continue;
        if (hs > cur) pieces.push({ s: new Date(cur), e: new Date(hs) });
        cur = Math.max(cur, he);
      }
      if (cur < r.e.getTime()) pieces.push({ s: new Date(cur), e: r.e });
    }
    const out: Part[] = [];
    for (const r of pieces) {
      const last = out.at(-1);
      if (last && r.s.getTime() - last.to.getTime() <= JOIN_TOLERANCE_MS) {
        if (r.e > last.to) last.to = r.e;
      } else out.push({ from: r.s, to: r.e });
    }
    return out.filter((p) => p.to.getTime() - p.from.getTime() >= 1000);
  }
}

interface Part {
  from: Date;
  to: Date;
}

const JOIN_TOLERANCE_MS = 1000;
/**
 * O banco guarda o início dos segmentos em milissegundos; o arquivo começa até 1 ms
 * depois (microssegundos). Pedir exatamente o início cairia na lacuna (404).
 */
const START_MARGIN_MS = 5;
const MAX_EXPORT_PARTS = 200;

/**
 * Junta os blocos num MP4 só (sem recodificar), lendo direto do servidor de reprodução e
 * entregando MP4 fragmentado em fluxo — nada é gravado em disco. As lacunas somem do
 * arquivo (um bloco emenda no outro); o nome e a auditoria registram o trecho pedido.
 */
function concatParts(urls: string[], log: FastifyRequest["log"]): Readable {
  const list = urls.map((u) => `file '${u}'`).join("\n");
  const listPath = join(tmpdir(), `topcam-export-${randomBytes(8).toString("hex")}.txt`);
  writeFileSync(listPath, list, { mode: 0o600 });
  const ff = spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-protocol_whitelist",
      "file,http,tcp",
      "-i",
      listPath,
      "-map",
      "0",
      "-c",
      "copy",
      "-movflags",
      "frag_keyframe+empty_moov+default_base_moof",
      "-f",
      "mp4",
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let err = "";
  ff.stderr.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
  const done = () => rmSync(listPath, { force: true });
  ff.on("close", (code) => {
    done();
    if (code)
      log.error(
        { code, err: err.replace(/\/\/[^@/]+@/g, "//***@") },
        "falha ao juntar a exportação",
      );
  });
  ff.on("error", done);
  // Download cancelado: encerra o ffmpeg.
  ff.stdout.on("close", () => ff.kill("SIGKILL"));
  return ff.stdout;
}
