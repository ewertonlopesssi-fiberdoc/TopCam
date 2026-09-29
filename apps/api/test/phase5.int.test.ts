import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createPool, type Pool } from "@topcam/db";
import { signLiveToken, type MediaMtxClient } from "@topcam/shared";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  REDIS_URL,
  createTestDb,
  ownerQuery,
  type TestDb,
} from "../../../packages/db/test/helpers.js";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";

/** Gravações (Fase 5): calendário, reprodução pelo gateway e exportação MP4 auditada. */

let db: TestDb;
let pool: Pool;
let redis: Redis;
let app: FastifyInstance;
let mtx: Server;
const mtxRequests: string[] = [];
const SECRET = randomBytes(24).toString("hex");
const SAMPLE_MP4 = join(tmpdir(), `topcam-test-${randomBytes(4).toString("hex")}.mp4`);
const JWT_SECRET = randomBytes(32).toString("hex");

beforeAll(async () => {
  // Servidor de reprodução falso (o MediaMTX real é testado no aceite).
  // Servidor de reprodução falso: entrega um MP4 real de 2 s (nas exportações com
  // lacunas a API junta os blocos com ffmpeg).
  execFileSync("ffmpeg", [
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=160x90:rate=10",
    "-t",
    "2",
    "-c:v",
    "libx264",
    "-g",
    "10",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    SAMPLE_MP4,
  ]);
  mtx = createServer((req, res) => {
    mtxRequests.push(`${req.url} ${req.headers.authorization ?? ""}`);
    res.writeHead(200, { "content-type": "video/mp4" });
    res.end(readFileSync(SAMPLE_MP4));
  });
  await new Promise<void>((r) => mtx.listen(0, "127.0.0.1", r));
  db = await createTestDb();
  pool = createPool(db.appUrl, 4);
  redis = new Redis(REDIS_URL);
  await redis.flushdb();
  app = await buildApp({
    env: loadEnv({
      DATABASE_URL: db.appUrl,
      REDIS_URL,
      MEDIA_HOOK_SECRET: SECRET,
      MEDIA_READ_PASSWORD: "senha-interna-de-leitura-123",
      MEDIA_GATEWAY_TOKEN: "gateway-token-de-teste-1234567890",
      STREAM_KEY_ENC_KEY: db.encKeyB64,
      JWT_SECRET,
      LOG_LEVEL: "silent",
      MEDIAMTX_PLAYBACK_URL: `http://127.0.0.1:${(mtx.address() as AddressInfo).port}`,
      EXPORT_MAX_S: "1800",
    }),
    pool,
    redis,
    mediamtx: { listPaths: async () => [], getPath: async () => null } as unknown as MediaMtxClient,
  });
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  redis?.disconnect();
  await db?.drop();
  mtx?.close();
  rmSync(SAMPLE_MP4, { force: true });
});

async function login(email: string, password: string) {
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password },
  });
  return r.json().accessToken as string;
}
function api(token: string) {
  const call = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      payload: payload as object,
      headers: { authorization: `Bearer ${token}` },
    });
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
    put: (u: string, p: unknown) => call("PUT", u, p),
  };
}
async function activate(email: string, temp: string, next: string) {
  const t = await login(email, temp);
  await api(t).post("/api/v1/auth/change-password", { currentPassword: temp, newPassword: next });
  return t;
}
function gateway(uri: string, method = "GET", secret = SECRET) {
  return app.inject({
    method: "GET",
    url: `/internal/playback/auth?secret=${secret}`,
    headers: { "x-forwarded-uri": uri, "x-forwarded-method": method },
  });
}

let admin = "";
let viewer = "";
let viewerId = "";
let cam1 = "";
let cam2 = "";
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

beforeAll(async () => {
  admin = await activate("admin@test.local", "senha-de-teste-123", "NovaSenhaForte2026");
  const rows = await ownerQuery<{ id: string; code: string; tenant_id: string }>(
    db,
    "SELECT c.id, c.code, c.tenant_id FROM cameras c JOIN tenants t ON t.id = c.tenant_id WHERE t.slug = 'empresa-alfa'",
  );
  cam1 = rows.find((r) => r.code === "CAM-001")!.id;
  cam2 = rows.find((r) => r.code === "CAM-002")!.id;
  // Dez minutos gravados (terminando há 5 min) + um segmento de ontem.
  const segs: Array<[number, number]> = [];
  for (let i = 0; i < 10; i++) segs.push([now - 15 * 60_000 + i * 60_000, 60_000]);
  segs.push([now - 26 * 3600_000, 60_000]);
  for (const [start, dur] of segs)
    await ownerQuery(
      db,
      `INSERT INTO recording_segments (tenant_id, camera_id, storage_node_id, path, started_at, ended_at, duration_ms,
                                       size_bytes, state, expires_at)
       SELECT c.tenant_id, c.id, (SELECT id FROM storage_nodes LIMIT 1), 'cam/' || c.id || '/' || $2 || '.mp4',
              $3::timestamptz, $3::timestamptz + make_interval(secs => $4::int / 1000.0), $4, 1000, 'verified',
              now() + interval '1 day'
         FROM cameras c WHERE c.id = $1`,
      [cam1, String(start), iso(start), dur],
    );
  const alfa = rows[0]!.tenant_id;
  const v = (
    await api(admin).post("/api/v1/users", {
      name: "Vigia",
      email: "vigia@alfa.test",
      role: "viewer",
      tenantId: alfa,
    })
  ).json();
  viewerId = v.user.id;
  viewer = await activate("vigia@alfa.test", v.temporaryPassword, "PortariaSegura2026");
});

const grant = (items: unknown[]) =>
  api(admin).put(`/api/v1/users/${viewerId}/camera-permissions`, { items });

describe("calendário", () => {
  it("lista os dias com gravação no fuso pedido", async () => {
    const d = (ms: number) =>
      new Date(ms).toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
    const r = await api(admin).get(
      `/api/v1/cameras/${cam1}/recordings/days?from=${d(now - 3 * 86400_000)}&to=${d(now)}&tz=America/Sao_Paulo`,
    );
    expect(r.statusCode).toBe(200);
    const items = r.json().items as Array<{ day: string; seconds: number; segments: number }>;
    expect(items.reduce((a, x) => a + x.segments, 0)).toBe(11);
    expect(items.find((x) => x.day === d(now - 15 * 60_000))!.seconds).toBeGreaterThanOrEqual(540);
    expect(
      (
        await api(admin).get(
          `/api/v1/cameras/${cam1}/recordings/days?from=2026-09-01&to=2026-09-30&tz=Lua/Base`,
        )
      ).statusCode,
    ).toBe(400);
  });
});

describe("reprodução pelo gateway", () => {
  async function playbackUrl(token: string, cam = cam1) {
    const r = await api(token).post(`/api/v1/cameras/${cam}/playback`);
    expect(r.statusCode).toBe(200);
    return r.json().url as string;
  }

  it("libera só a câmera do token, com intervalo e formato válidos", async () => {
    const url = await playbackUrl(admin);
    expect(url).toMatch(new RegExp(`^/playback/v1\\.[^/]+/get\\?path=cam/${cam1}&format=fmp4$`));
    const ok = await gateway(`${url}&start=${iso(now - 10 * 60_000)}&duration=120`);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["x-media-path"]).toBe("/get");
    expect(
      (await gateway(url.replace(cam1, cam2) + `&start=${iso(now)}&duration=60`)).statusCode,
    ).toBe(403);
    expect((await gateway(`${url}&start=${iso(now)}&duration=7200`)).statusCode).toBe(400);
    expect((await gateway(`${url}&duration=60`)).statusCode).toBe(400);
    expect(
      (await gateway(url.replace("format=fmp4", "format=mp4") + `&start=${iso(now)}&duration=60`))
        .statusCode,
    ).toBe(400);
    expect((await gateway(`${url}&start=${iso(now)}&duration=60`, "POST")).statusCode).toBe(405);
    expect((await gateway(url.replace("/get?", "/list?"))).statusCode).toBe(403);
    expect(
      (
        await gateway(
          `/playback/curto/get?path=cam/${cam1}&start=${iso(now)}&duration=60&format=fmp4`,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (await gateway(`${url}&start=${iso(now)}&duration=60`, "GET", "errado")).statusCode,
    ).toBe(403);
    const audits = await ownerQuery(
      db,
      "SELECT 1 FROM audit_logs WHERE action = 'camera.playback_viewed'",
    );
    expect(audits).toHaveLength(1);
  });

  it("token de ao vivo não serve para gravações, e o de gravações não serve para o ao vivo", async () => {
    const live = (await api(admin).post(`/api/v1/cameras/${cam1}/live`)).json();
    const liveToken = live.hls.split("/")[2];
    expect(
      (
        await gateway(
          `/playback/${liveToken}/get?path=cam/${cam1}&start=${iso(now)}&duration=60&format=fmp4`,
        )
      ).statusCode,
    ).toBe(403);
    const pbToken = (await playbackUrl(admin)).split("/")[2];
    const r = await app.inject({
      method: "GET",
      url: `/internal/live/auth?secret=${SECRET}`,
      headers: { "x-forwarded-uri": `/live/${pbToken}/index.m3u8`, "x-forwarded-method": "GET" },
    });
    expect(r.statusCode).toBe(403);
  });

  it('visualizador precisa de "pode reproduzir"; ao vivo sozinho não basta', async () => {
    await grant([{ cameraId: cam1, canLive: true }]);
    expect((await api(viewer).post(`/api/v1/cameras/${cam1}/playback`)).statusCode).toBe(404);
    expect(
      (
        await api(viewer).get(
          `/api/v1/cameras/${cam1}/recordings/days?from=2026-09-01&to=2026-09-30`,
        )
      ).statusCode,
    ).toBe(404);
    await grant([{ cameraId: cam1, canLive: true, canPlayback: true }]);
    const url = await playbackUrl(viewer);
    expect((await gateway(`${url}&start=${iso(now - 60_000)}&duration=60`)).statusCode).toBe(200);
    // Retirar a permissão corta a reprodução no próximo pedido.
    await grant([{ cameraId: cam1, canLive: true }]);
    expect((await gateway(`${url}&start=${iso(now - 60_000)}&duration=60`)).statusCode).toBe(403);
  });
});

describe("exportação MP4", () => {
  it('exige "pode exportar", valida o trecho e registra na auditoria', async () => {
    await grant([{ cameraId: cam1, canLive: true, canPlayback: true }]);
    const body = { start: iso(now - 12 * 60_000), end: iso(now - 8 * 60_000) };
    expect((await api(viewer).post(`/api/v1/cameras/${cam1}/exports`, body)).statusCode).toBe(403);
    await grant([{ cameraId: cam1, canLive: true, canPlayback: true, canExport: true }]);
    const a = api(viewer);
    expect(
      (await a.post(`/api/v1/cameras/${cam1}/exports`, { start: body.end, end: body.start }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await a.post(`/api/v1/cameras/${cam1}/exports`, {
          start: iso(now - 3 * 3600_000),
          end: iso(now - 20 * 60_000),
        })
      ).statusCode,
    ).toBe(400); // acima do máximo (30 min neste teste)
    const none = await a.post(`/api/v1/cameras/${cam1}/exports`, {
      start: iso(now - 3 * 3600_000),
      end: iso(now - 3 * 3600_000 + 60_000),
    });
    expect(none.statusCode).toBe(404);
    expect(none.json().error).toBe("no_recording");
    const ok = await a.post(`/api/v1/cameras/${cam1}/exports`, body);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ seconds: 240, recordedSeconds: 240 });
    expect(ok.json().filename).toMatch(/^CAM-001_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_4min\.mp4$/);

    // Download sem cabeçalho de login: o link é o token.
    const dl = await app.inject({ method: "GET", url: ok.json().downloadUrl });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["content-type"]).toBe("video/mp4");
    expect(dl.headers["content-disposition"]).toContain(`filename="${ok.json().filename}"`);
    expect(dl.rawPayload.length).toBe(readFileSync(SAMPLE_MP4).length);
    const last = mtxRequests.at(-1)!;
    expect(last).toContain(`/get?path=cam/${cam1}&start=`);
    expect(last).toContain("&duration=240&format=mp4");
    expect(last).toContain(
      `Basic ${Buffer.from("topcam-internal:senha-interna-de-leitura-123").toString("base64")}`,
    );
    const audits = await ownerQuery<{ action: string; actor_user_id: string }>(
      db,
      "SELECT action, actor_user_id FROM audit_logs WHERE action IN ('camera.export_requested', 'camera.exported') ORDER BY id",
    );
    expect(audits.map((x) => x.action)).toEqual(["camera.export_requested", "camera.exported"]);
    expect(audits.every((x) => x.actor_user_id === viewerId)).toBe(true);

    // Sem a permissão, o link deixa de valer.
    await grant([{ cameraId: cam1, canLive: true, canPlayback: true }]);
    expect((await app.inject({ method: "GET", url: ok.json().downloadUrl })).statusCode).toBe(403);
  });

  it("link vencido, adulterado ou de outra finalidade é recusado", async () => {
    const me = (await api(admin).get("/api/v1/auth/me")).json();
    const [s] = await ownerQuery<{ id: string }>(
      db,
      "SELECT id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",
      [me.id],
    );
    const base = { c: cam1, u: me.id, s: s!.id, a: now - 10 * 60_000, d: 60 };
    const expired = signLiveToken(JWT_SECRET, { ...base, e: Math.floor(now / 1000) - 5, k: "x" });
    expect(
      (await app.inject({ method: "GET", url: `/api/v1/exports/${expired}` })).statusCode,
    ).toBe(410);
    const playback = signLiveToken(JWT_SECRET, { ...base, e: Math.floor(now / 1000) + 60, k: "p" });
    expect(
      (await app.inject({ method: "GET", url: `/api/v1/exports/${playback}` })).statusCode,
    ).toBe(403);
    const good = signLiveToken(JWT_SECRET, { ...base, e: Math.floor(now / 1000) + 60, k: "x" });
    expect((await app.inject({ method: "GET", url: `/api/v1/exports/${good}x` })).statusCode).toBe(
      403,
    );
    expect((await app.inject({ method: "GET", url: `/api/v1/exports/${good}` })).statusCode).toBe(
      200,
    );
  });
});

describe("exportação com lacunas", () => {
  it("pede cada bloco contínuo ao servidor de reprodução e junta num MP4 só", async () => {
    // Dois segmentos de 60 s de 3 h atrás com 20 s de intervalo entre eles.
    const base = now - 3 * 3600_000;
    for (const start of [base, base + 80_000])
      await ownerQuery(
        db,
        `INSERT INTO recording_segments (tenant_id, camera_id, storage_node_id, path, started_at, ended_at, duration_ms,
                                         size_bytes, state, expires_at)
         SELECT c.tenant_id, c.id, (SELECT id FROM storage_nodes LIMIT 1), 'cam/' || c.id || '/g' || $2 || '.mp4',
                $3::timestamptz, $3::timestamptz + interval '60 s', 60000, 1000, 'verified', now() + interval '1 day'
           FROM cameras c WHERE c.id = $1`,
        [cam1, String(start), iso(start)],
      );
    const r = await api(admin).post(`/api/v1/cameras/${cam1}/exports`, {
      start: iso(base + 30_000),
      end: iso(base + 110_000),
    });
    expect(r.json()).toMatchObject({ seconds: 80, recordedSeconds: 60 });
    const before = mtxRequests.length;
    const dl = await app.inject({ method: "GET", url: r.json().downloadUrl });
    expect(dl.statusCode).toBe(200);
    const parts = mtxRequests.slice(before);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain(
      `start=${encodeURIComponent(iso(base + 30_005))}&duration=30&format=mp4`,
    );
    expect(parts[1]).toContain(
      `start=${encodeURIComponent(iso(base + 80_005))}&duration=30&format=mp4`,
    );
    const out = join(tmpdir(), `topcam-test-out-${randomBytes(4).toString("hex")}.mp4`);
    writeFileSync(out, dl.rawPayload);
    const dur = Number(
      execFileSync("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "csv=p=0",
        out,
      ])
        .toString()
        .trim(),
    );
    rmSync(out, { force: true });
    expect(dur).toBeGreaterThan(3.5); // 2 blocos × 2 s do servidor falso
    expect(dur).toBeLessThan(4.5);
    const [a] = await ownerQuery<{ data: { parts: number; recorded_seconds: number } }>(
      db,
      "SELECT data FROM audit_logs WHERE action = 'camera.exported' ORDER BY id DESC LIMIT 1",
    );
    expect(a!.data).toMatchObject({ parts: 2, recorded_seconds: 60 });
  });
});

describe("servidor de reprodução", () => {
  it("o token do gateway pode reproduzir cam/<id>, e só isso", async () => {
    const auth = (body: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: `/internal/mediamtx/auth?secret=${SECRET}`,
        payload: body,
      });
    expect(
      (
        await auth({
          action: "playback",
          path: `cam/${cam1}`,
          token: "gateway-token-de-teste-1234567890",
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await auth({
          action: "playback",
          path: `live/${"a".repeat(40)}`,
          token: "gateway-token-de-teste-1234567890",
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await auth({ action: "playback", path: `cam/${cam1}`, token: "errado" })).statusCode,
    ).toBe(401);
  });
});
