import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { createPool, type Pool } from "@topcam/db";
import type { MediaMtxClient } from "@topcam/shared";
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

/**
 * Push dos alarmes (Fase 9.3): registro do celular, troca de conta no mesmo celular,
 * desligar, remover só o próprio, notificação de teste (serviço da Expo falso) e sessão
 * encerrada sem push.
 */

let db: TestDb;
let pool: Pool;
let redis: Redis;
let app: FastifyInstance;
let expo: Server;
const received: Array<{ path: string; auth: string; body: unknown }> = [];

beforeAll(async () => {
  expo = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw || "null");
      received.push({ path: req.url ?? "", auth: req.headers.authorization ?? "", body });
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          data: (body as unknown[]).map((_, i) => ({ status: "ok", id: `tk-${i}` })),
        }),
      );
    });
  });
  await new Promise<void>((r) => expo.listen(0, "127.0.0.1", r));
  db = await createTestDb();
  pool = createPool(db.appUrl, 4);
  redis = new Redis(REDIS_URL);
  await redis.flushdb();
  app = await buildApp({
    env: loadEnv({
      DATABASE_URL: db.appUrl,
      REDIS_URL,
      MEDIA_HOOK_SECRET: randomBytes(24).toString("hex"),
      MEDIA_READ_PASSWORD: randomBytes(16).toString("hex"),
      MEDIA_GATEWAY_TOKEN: "gateway-token-de-teste-1234567890",
      STREAM_KEY_ENC_KEY: db.encKeyB64,
      JWT_SECRET: randomBytes(32).toString("hex"),
      LOG_LEVEL: "silent",
      EXPO_PUSH_URL: `http://127.0.0.1:${(expo.address() as AddressInfo).port}`,
      EXPO_ACCESS_TOKEN: "token-expo-de-teste",
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
  await new Promise<void>((r) => expo?.close(() => r()));
});

async function login(email: string, password: string) {
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password, client: "mobile" },
  });
  return r.json().accessToken as string;
}
const call = (token: string, method: "POST" | "DELETE", url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    payload: (payload ?? {}) as object,
    headers: { authorization: `Bearer ${token}` },
  });

const T1 = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";
let admin = "";
let viewer = "";
let viewerId = "";

beforeAll(async () => {
  const t = await login("admin@test.local", "senha-de-teste-123");
  await call(t, "POST", "/api/v1/auth/change-password", {
    currentPassword: "senha-de-teste-123",
    newPassword: "NovaSenha2026",
  });
  admin = await login("admin@test.local", "NovaSenha2026");
  const alfa = (
    await ownerQuery<{ id: string }>(db, "SELECT id FROM tenants WHERE slug = 'empresa-alfa'")
  )[0]!.id;
  const u = await call(admin, "POST", "/api/v1/users", {
    name: "Porteiro",
    email: "porteiro@alfa.test",
    role: "viewer",
    tenantId: alfa,
    password: "Porteiro2026",
  });
  viewerId = u.json().user.id;
  viewer = await login("porteiro@alfa.test", "Porteiro2026");
});

const deviceRow = async () =>
  (
    await ownerQuery<{
      user_id: string;
      enabled: boolean;
      disabled_reason: string | null;
      session_id: string | null;
      tenant_id: string | null;
    }>(
      db,
      "SELECT user_id, enabled, disabled_reason, session_id, tenant_id FROM push_devices WHERE token = $1",
      [T1],
    )
  )[0];

describe("push: celulares", () => {
  it("exige login e token no formato da Expo", async () => {
    const a = await app.inject({
      method: "POST",
      url: "/api/v1/push/devices",
      payload: { token: T1, platform: "android" },
    });
    expect(a.statusCode).toBe(401);
    const b = await call(viewer, "POST", "/api/v1/push/devices", {
      token: "qualquer-coisa",
      platform: "android",
    });
    expect(b.statusCode).toBe(400);
  });

  it("registra o celular ligado ao usuário e à sessão; repetir não duplica nem audita de novo", async () => {
    const r = await call(viewer, "POST", "/api/v1/push/devices", {
      token: T1,
      platform: "android",
      deviceName: "Moto G",
      appVersion: "0.3.0",
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, enabled: true });
    await call(viewer, "POST", "/api/v1/push/devices", { token: T1, platform: "android" });
    const d = await deviceRow();
    expect(d!.user_id).toBe(viewerId);
    expect(d!.session_id).not.toBeNull();
    expect(d!.tenant_id).not.toBeNull();
    const n = await ownerQuery<{ data: Record<string, unknown> }>(
      db,
      "SELECT data FROM audit_logs WHERE action = 'push.device_enabled'",
    );
    expect(n.length).toBe(1);
    // O token do celular não vai para a auditoria.
    expect(JSON.stringify(n[0]!.data)).not.toContain("ExponentPushToken");
  });

  it("notificação de teste vai para os celulares do próprio usuário", async () => {
    received.length = 0;
    const r = await call(viewer, "POST", "/api/v1/push/test");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ sent: 1, failed: 0, errors: [] });
    expect(received[0]!.path).toBe("/send");
    expect(received[0]!.auth).toBe("Bearer token-expo-de-teste");
    expect(received[0]!.body).toEqual([
      expect.objectContaining({ to: T1, channelId: "alarmes", data: { type: "test" } }),
    ]);
    // O administrador não tem celular registrado.
    const a = await call(admin, "POST", "/api/v1/push/test");
    expect(a.statusCode).toBe(404);
  });

  it("desligar as notificações no app", async () => {
    await call(viewer, "POST", "/api/v1/push/devices", {
      token: T1,
      platform: "android",
      enabled: false,
    });
    expect(await deviceRow()).toMatchObject({ enabled: false, disabled_reason: "usuario" });
    expect((await call(viewer, "POST", "/api/v1/push/test")).statusCode).toBe(404);
    await call(viewer, "POST", "/api/v1/push/devices", { token: T1, platform: "android" });
    expect(await deviceRow()).toMatchObject({ enabled: true, disabled_reason: null });
  });

  it("outra conta no mesmo celular passa a receber; só o dono remove", async () => {
    await call(admin, "POST", "/api/v1/push/devices", { token: T1, platform: "ios" });
    const d = await deviceRow();
    expect(d!.user_id).not.toBe(viewerId);
    expect(d!.tenant_id).toBeNull(); // equipe da plataforma
    const other = await call(viewer, "DELETE", "/api/v1/push/devices", { token: T1 });
    expect(other.json()).toEqual({ ok: true, removed: 0 });
    const own = await call(admin, "DELETE", "/api/v1/push/devices", { token: T1 });
    expect(own.json()).toEqual({ ok: true, removed: 1 });
    expect(await deviceRow()).toBeUndefined();
  });

  it("sair do app encerra a sessão: o celular deixa de receber", async () => {
    await call(viewer, "POST", "/api/v1/push/devices", { token: T1, platform: "android" });
    expect((await call(viewer, "POST", "/api/v1/push/test")).statusCode).toBe(200);
    await call(viewer, "POST", "/api/v1/auth/logout");
    const again = await login("porteiro@alfa.test", "Porteiro2026");
    // Logado de novo em outro aparelho (sem registrar este token): a sessão antiga não recebe.
    expect((await call(again, "POST", "/api/v1/push/test")).statusCode).toBe(404);
  });
});
