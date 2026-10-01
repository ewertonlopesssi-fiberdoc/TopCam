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
 * Retenção de 3 e 7 dias (migração 0010): opções oferecidas ao cadastro e, ao trocar a
 * retenção de uma câmera, as gravações que já existem passam a vencer no novo prazo.
 */

let db: TestDb;
let pool: Pool;
let redis: Redis;
let app: FastifyInstance;

beforeAll(async () => {
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
      PANEL_URL: "http://painel.teste",
      LOG_LEVEL: "silent",
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
});

async function loginRaw(email: string, password: string) {
  return app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password },
  });
}
async function login(email: string, password: string) {
  return (await loginRaw(email, password)).json().accessToken as string;
}
function api(token: string) {
  const call = (
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
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
    put: (u: string, p: unknown) => call("PUT", u, p),
    patch: (u: string, p: unknown) => call("PATCH", u, p),
    del: (u: string) => call("DELETE", u),
  };
}

let admin = "";
let _gestor = "";

beforeAll(async () => {
  const t = await login("admin@test.local", "senha-de-teste-123");
  await api(t).post("/api/v1/auth/change-password", {
    currentPassword: "senha-de-teste-123",
    newPassword: "NovaSenha2026",
  });
  admin = await login("admin@test.local", "NovaSenha2026");
  const alfa = (
    await ownerQuery<{ id: string }>(db, "SELECT id FROM tenants WHERE slug = 'empresa-alfa'")
  )[0]!.id;
  await api(admin).post("/api/v1/users", {
    name: "Gestor",
    email: "gestor@alfa.test",
    role: "tenant_admin",
    tenantId: alfa,
    password: "GestorAlfa1",
  });
  _gestor = await login("gestor@alfa.test", "GestorAlfa1");
});

describe("opções de retenção", () => {
  it("o cadastro oferece 24 horas, 3 dias e 7 dias (globais)", async () => {
    const meta = (await api(admin).get("/api/v1/meta")).json();
    const globais = meta.retentionPolicies
      .filter((p: { tenantId: string | null }) => p.tenantId === null)
      .map((p: { name: string; retentionHours: number }) => `${p.name}=${p.retentionHours}`);
    expect(globais).toEqual(["24 horas=24", "3 dias=72", "7 dias=168"]);
  });

  it("trocar a câmera para 7 dias estende as gravações existentes", async () => {
    const cam = (
      await ownerQuery<{ id: string; tenant_id: string }>(
        db,
        "SELECT id, tenant_id FROM cameras WHERE code = 'CAM-001' AND recording_enabled LIMIT 1",
      )
    )[0]!;
    const node = (await ownerQuery<{ id: string }>(db, "SELECT id FROM storage_nodes LIMIT 1"))[0]!
      .id;
    await ownerQuery(
      db,
      `INSERT INTO recording_segments (tenant_id, camera_id, storage_node_id, path, started_at, ended_at, duration_ms, state, expires_at)
       VALUES ($1, $2, $3, 'cam/teste/retencao.mp4', now() - interval '2 hours', now() - interval '119 minutes', 60000, 'verified', now() + interval '22 hours')`,
      [cam.tenant_id, cam.id, node],
    );
    const seven = (
      await ownerQuery<{ id: string }>(
        db,
        "SELECT id FROM retention_policies WHERE tenant_id IS NULL AND name = '7 dias'",
      )
    )[0]!.id;
    const r = await api(admin).patch(`/api/v1/cameras/${cam.id}`, { retentionPolicyId: seven });
    expect(r.statusCode).toBe(200);
    const left = (
      await ownerQuery<{ h: number }>(
        db,
        "SELECT round(extract(epoch FROM expires_at - now()) / 3600)::int AS h FROM recording_segments WHERE path = 'cam/teste/retencao.mp4'",
      )
    )[0]!.h;
    expect(left).toBe(166); // 7 dias desde o início (há 2 h)
  });
});
