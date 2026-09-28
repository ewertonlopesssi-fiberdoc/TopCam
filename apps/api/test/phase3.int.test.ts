import { randomBytes } from "node:crypto";
import { createPool, type Pool } from "@topcam/db";
import { type MediaMtxClient } from "@topcam/shared";
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
import { parseLivePath, signLiveToken, verifyLiveToken } from "@topcam/shared";

/** Ao vivo (Fase 3): endereços temporários, forward_auth do gateway e leitura no MediaMTX. */

let db: TestDb;
let pool: Pool;
let redis: Redis;
let app: FastifyInstance;

const SECRET = randomBytes(24).toString("hex");
const JWT_SECRET = randomBytes(32).toString("hex");
const GATEWAY_TOKEN = "gateway-token-de-teste-1234567890";

beforeAll(async () => {
  db = await createTestDb();
  pool = createPool(db.appUrl, 4);
  redis = new Redis(REDIS_URL);
  await redis.flushdb();
  const env = loadEnv({
    DATABASE_URL: db.appUrl,
    REDIS_URL,
    MEDIA_HOOK_SECRET: SECRET,
    MEDIA_READ_PASSWORD: randomBytes(16).toString("hex"),
    MEDIA_GATEWAY_TOKEN: GATEWAY_TOKEN,
    STREAM_KEY_ENC_KEY: db.encKeyB64,
    JWT_SECRET,
    LOG_LEVEL: "silent",
    // Sem cache: cada pedido reconfere sessão e permissão (o padrão é 5 s).
    LIVE_AUTH_CACHE_S: "0",
  });
  app = await buildApp({
    env,
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
});

async function login(email: string, password: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password },
  });
  return res.json().accessToken as string;
}

function api(token: string) {
  const call = (
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    url: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      payload: payload as object,
      headers: { authorization: `Bearer ${token}` },
    });
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
    patch: (u: string, p: unknown) => call("PATCH", u, p),
    put: (u: string, p: unknown) => call("PUT", u, p),
  };
}

async function activate(email: string, temp: string, next: string) {
  const token = await login(email, temp);
  const r = await api(token).post("/api/v1/auth/change-password", {
    currentPassword: temp,
    newPassword: next,
  });
  expect(r.statusCode).toBe(200);
  return token;
}

/** Simula o forward_auth do Caddy. */
function gateway(uri: string, method = "GET", secret = SECRET) {
  return app.inject({
    method: "GET",
    url: `/internal/live/auth?secret=${secret}`,
    headers: { "x-forwarded-uri": uri, "x-forwarded-method": method },
  });
}

/** Simula o MediaMTX perguntando se pode ler. */
function mediaAuth(body: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/internal/mediamtx/auth?secret=${SECRET}`,
    payload: body,
  });
}

let adminToken = "";
let viewerToken = "";
let viewerId = "";
const cams: Record<string, string> = {};

beforeAll(async () => {
  adminToken = await activate("admin@test.local", "senha-de-teste-123", "NovaSenhaForte2026");
  const rows = await ownerQuery<{ id: string; code: string; slug: string }>(
    db,
    `SELECT c.id, c.code, t.slug FROM cameras c JOIN tenants t ON t.id = c.tenant_id`,
  );
  for (const r of rows) cams[`${r.slug}/${r.code}`] = r.id;
  const alfa = (
    await ownerQuery<{ id: string }>(db, "SELECT id FROM tenants WHERE slug = 'empresa-alfa'")
  )[0]!.id;
  const v = await api(adminToken).post("/api/v1/users", {
    name: "Porteiro",
    email: "porteiro@alfa.test",
    role: "viewer",
    tenantId: alfa,
  });
  viewerId = v.json().user.id;
  viewerToken = await activate(
    "porteiro@alfa.test",
    v.json().temporaryPassword,
    "AcessoPortao2026",
  );
  await api(adminToken).put(`/api/v1/users/${viewerId}/camera-permissions`, {
    items: [{ cameraId: cams["empresa-alfa/CAM-002"], canLive: true }],
  });
});

describe("token do ao vivo", () => {
  it("assina, confere e recusa adulteração e expiração", () => {
    const claims = { c: "c1", u: "u1", s: "s1", e: Math.floor(Date.now() / 1000) + 60 };
    const t = signLiveToken("segredo-1234567890-segredo-1234567890", claims);
    expect(verifyLiveToken("segredo-1234567890-segredo-1234567890", t)).toEqual({
      ok: true,
      claims,
    });
    expect(verifyLiveToken("outro-segredo-1234567890-1234567890", t)).toMatchObject({
      ok: false,
      reason: "bad_signature",
    });
    const [p, b, s] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ ...claims, c: "c2" })).toString("base64url");
    expect(verifyLiveToken("segredo-1234567890-segredo-1234567890", `${p}.${forged}.${s}`).ok).toBe(
      false,
    );
    expect(verifyLiveToken("segredo-1234567890-segredo-1234567890", `${p}.${b}`).ok).toBe(false);
    const old = signLiveToken("segredo-1234567890-segredo-1234567890", { ...claims, e: 1000 });
    expect(verifyLiveToken("segredo-1234567890-segredo-1234567890", old)).toMatchObject({
      ok: false,
      reason: "expired",
    });
  });

  it("aceita só os recursos de HLS e WHEP", () => {
    const tok = "v1.aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbb";
    expect(parseLivePath(`/live/${tok}/index.m3u8?cookieCheck=1`)).toMatchObject({
      kind: "hls",
      rest: "index.m3u8",
      query: "cookieCheck=1",
    });
    expect(parseLivePath(`/live/${tok}/abc_video1_part3.mp4?session=x`)).toMatchObject({
      kind: "hls",
    });
    expect(parseLivePath(`/live/${tok}/whep`)).toMatchObject({ kind: "whep" });
    expect(parseLivePath(`/live/${tok}/whep/0a1b-2c3d`)).toMatchObject({ kind: "whep" });
    for (const bad of [
      `/live/${tok}/`,
      `/live/${tok}/../../api`,
      `/live/${tok}/index.html`,
      `/live/${tok}/a/b.m3u8`,
      `/live/curto/index.m3u8`,
      "/live/index.m3u8",
    ])
      expect(parseLivePath(bad), bad).toBeNull();
  });
});

describe("endereços temporários", () => {
  it("administrador recebe endereços para o mosaico, sem chave nem caminho interno", async () => {
    const ids = ["CAM-001", "CAM-002", "CAM-003"].map((c) => cams[`empresa-alfa/${c}`]!);
    const r = await api(adminToken).post("/api/v1/live/sessions", { cameraIds: ids });
    expect(r.statusCode).toBe(200);
    const items = r.json().items;
    expect(items).toHaveLength(3);
    for (const it of items) {
      expect(it.ok).toBe(true);
      expect(it.hls).toMatch(/^\/live\/v1\.[^/]+\/index\.m3u8\?cookieCheck=1$/);
      expect(it.whep).toMatch(/^\/live\/(v1\.[^/]+)\/whep\?t=\1$/);
      expect(JSON.stringify(it)).not.toContain("cam/");
    }
    const keys = await ownerQuery<{ stream_key_prefix: string }>(
      db,
      "SELECT stream_key_prefix FROM cameras",
    );
    for (const k of keys) expect(r.body).not.toContain(k.stream_key_prefix);
    expect(
      await ownerQuery(db, "SELECT 1 FROM audit_logs WHERE action = 'camera.live_viewed'"),
    ).toHaveLength(3);
    // Reabrir logo em seguida não duplica a auditoria.
    await api(adminToken).post("/api/v1/live/sessions", { cameraIds: ids });
    expect(
      await ownerQuery(db, "SELECT 1 FROM audit_logs WHERE action = 'camera.live_viewed'"),
    ).toHaveLength(3);
  });

  it("visualizador só recebe a câmera liberada", async () => {
    const v = api(viewerToken);
    const ok = await v.post(`/api/v1/cameras/${cams["empresa-alfa/CAM-002"]}/live`);
    expect(ok.statusCode).toBe(200);
    expect((await v.post(`/api/v1/cameras/${cams["empresa-alfa/CAM-001"]}/live`)).statusCode).toBe(
      404,
    );
    expect(
      (await v.post(`/api/v1/cameras/${cams["condominio-sol/CAM-001"]}/live`)).statusCode,
    ).toBe(404);
    const batch = await v.post("/api/v1/live/sessions", {
      cameraIds: [cams["empresa-alfa/CAM-002"], cams["empresa-alfa/CAM-003"]],
    });
    expect(batch.json().items.map((i: { ok: boolean }) => i.ok)).toEqual([true, false]);
  });

  it("câmera desabilitada não recebe endereço", async () => {
    const id = cams["empresa-alfa/CAM-005"]!;
    await api(adminToken).patch(`/api/v1/cameras/${id}`, { enabled: false });
    const r = await api(adminToken).post(`/api/v1/cameras/${id}/live`);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("camera_disabled");
    await api(adminToken).patch(`/api/v1/cameras/${id}`, { enabled: true });
  });
});

describe("gateway (forward_auth)", () => {
  async function hlsOf(token: string, camId: string) {
    return (await api(token).post(`/api/v1/cameras/${camId}/live`)).json().hls as string;
  }

  it("libera e devolve o caminho interno; recusa segredo errado, adulteração e recursos estranhos", async () => {
    const id = cams["empresa-alfa/CAM-002"]!;
    const hls = await hlsOf(viewerToken, id);
    const ok = await gateway(hls);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["x-media-path"]).toBe(`/cam/${id}/index.m3u8`);
    expect(ok.headers["x-media-kind"]).toBe("hls");
    const base = hls.split("/index.m3u8")[0];
    expect((await gateway(`${base}/abc_video1_seg3.mp4?session=x`)).headers["x-media-path"]).toBe(
      `/cam/${id}/abc_video1_seg3.mp4`,
    );
    const token = base.slice("/live/".length);
    expect((await gateway(`${base}/whep?t=${token}`, "POST")).headers["x-media-kind"]).toBe("whep");
    // Oferta WHEP sem o token na query (referência da sessão) é recusada.
    expect((await gateway(`${base}/whep`, "POST")).statusCode).toBe(400);
    expect((await gateway(`${base}/whep/0a1b-2c3d`, "PATCH")).statusCode).toBe(200);
    expect((await gateway(`${base}/whep`, "GET")).statusCode).toBe(405);
    expect((await gateway(`${base}/index.m3u8`, "POST")).statusCode).toBe(405);
    expect((await gateway(hls, "GET", "segredo-errado")).statusCode).toBe(403);
    expect((await gateway(`${base}/index.html`)).statusCode).toBe(404);
    const tampered = hls.replace(/\.([^./]+)\/index/, ".AAAA$1/index");
    expect((await gateway(tampered)).statusCode).toBe(403);
  });

  it("token expirado ou apontando para outra câmera é recusado", async () => {
    const me = (await api(viewerToken).get("/api/v1/auth/me")).json();
    const sid = (
      await ownerQuery<{ id: string }>(
        db,
        "SELECT id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",
        [me.id],
      )
    )[0]!.id;
    const expired = signLiveToken(JWT_SECRET, {
      c: cams["empresa-alfa/CAM-002"]!,
      u: me.id,
      s: sid,
      e: Math.floor(Date.now() / 1000) - 1,
    });
    const r = await gateway(`/live/${expired}/index.m3u8`);
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("expired");
    // Assinatura válida, mas para uma câmera sem permissão: recusado na reconferência.
    const other = signLiveToken(JWT_SECRET, {
      c: cams["empresa-alfa/CAM-001"]!,
      u: me.id,
      s: sid,
      e: Math.floor(Date.now() / 1000) + 60,
    });
    expect((await gateway(`/live/${other}/index.m3u8`)).statusCode).toBe(403);
  });

  it("perder a permissão, desativar o usuário ou sair corta o ao vivo na hora", async () => {
    const id = cams["empresa-alfa/CAM-002"]!;
    let hls = await hlsOf(viewerToken, id);
    expect((await gateway(hls)).statusCode).toBe(200);
    await api(adminToken).put(`/api/v1/users/${viewerId}/camera-permissions`, { items: [] });
    expect((await gateway(hls)).statusCode).toBe(403);
    await api(adminToken).put(`/api/v1/users/${viewerId}/camera-permissions`, {
      items: [{ cameraId: id, canLive: true }],
    });
    expect((await gateway(hls)).statusCode).toBe(200);
    // Permissão sem "ao vivo" também não vale.
    await api(adminToken).put(`/api/v1/users/${viewerId}/camera-permissions`, {
      items: [{ cameraId: id, canLive: false, canPlayback: true }],
    });
    expect((await gateway(hls)).statusCode).toBe(403);
    await api(adminToken).put(`/api/v1/users/${viewerId}/camera-permissions`, {
      items: [{ cameraId: id, canLive: true }],
    });
    // Sair (logout) encerra a sessão ligada ao token.
    expect((await api(viewerToken).post("/api/v1/auth/logout")).statusCode).toBe(200);
    expect((await gateway(hls)).statusCode).toBe(403);
    // Desativar o usuário.
    viewerToken = await login("porteiro@alfa.test", "AcessoPortao2026");
    hls = await hlsOf(viewerToken, id);
    expect((await gateway(hls)).statusCode).toBe(200);
    await api(adminToken).patch(`/api/v1/users/${viewerId}`, { status: "disabled" });
    expect((await gateway(hls)).statusCode).toBe(403);
  });
});

describe("leitura no servidor de mídia", () => {
  const cam = () => `cam/${cams["empresa-alfa/CAM-001"]}`;

  it("o gateway lê cam/<id> por HLS e WebRTC com o token dele", async () => {
    for (const protocol of ["hls", "webrtc"])
      expect(
        (await mediaAuth({ action: "read", path: cam(), protocol, token: GATEWAY_TOKEN }))
          .statusCode,
      ).toBe(200);
  });

  it("o token do gateway não lê a entrada live/<chave>, não publica e não usa outros protocolos", async () => {
    const live = `live/${"a".repeat(40)}`;
    expect(
      (await mediaAuth({ action: "read", path: live, protocol: "hls", token: GATEWAY_TOKEN }))
        .statusCode,
    ).toBe(401);
    expect(
      (await mediaAuth({ action: "read", path: cam(), protocol: "rtsp", token: GATEWAY_TOKEN }))
        .statusCode,
    ).toBe(401);
    expect(
      (await mediaAuth({ action: "publish", path: cam(), protocol: "rtmp", token: GATEWAY_TOKEN }))
        .statusCode,
    ).toBe(401);
    expect(
      (await mediaAuth({ action: "read", path: cam(), protocol: "hls", token: "errado" }))
        .statusCode,
    ).toBe(401);
    expect((await mediaAuth({ action: "read", path: cam(), protocol: "hls" })).statusCode).toBe(
      401,
    );
  });
});
