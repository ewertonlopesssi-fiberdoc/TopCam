import { randomBytes } from "node:crypto";
import { createPool, type Pool } from "@topcam/db";
import { hashStreamKey, type MediaMtxClient } from "@topcam/shared";
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
 * Transferência de câmera entre clientes: a câmera nova nasce no destino com o próximo
 * código e (por padrão) a mesma chave; a antiga sai da origem com o histórico dela;
 * permissões da origem somem; só a equipe da plataforma transfere.
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
  const call = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: unknown) =>
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
  };
}

let admin = "";
let alfa = "";

beforeAll(async () => {
  const t = await login("admin@test.local", "senha-de-teste-123");
  await api(t).post("/api/v1/auth/change-password", {
    currentPassword: "senha-de-teste-123",
    newPassword: "NovaSenha2026",
  });
  admin = await login("admin@test.local", "NovaSenha2026");
  alfa = (
    await ownerQuery<{ id: string }>(db, "SELECT id FROM tenants WHERE slug = 'empresa-alfa'")
  )[0]!.id;
});

async function sql<T extends Record<string, unknown>>(q: string, p: unknown[] = []) {
  return ownerQuery<T>(db, q, p);
}

describe("transferência de câmera para outro cliente", () => {
  let sol = "";
  let solLoc = "";
  let cam = "";
  let viewerId = "";
  let alfaAdmin = "";
  let solAdmin = "";

  beforeAll(async () => {
    sol = (await sql<{ id: string }>("SELECT id FROM tenants WHERE slug = 'condominio-sol'"))[0]!
      .id;
    solLoc = (
      await sql<{ id: string }>("SELECT id FROM locations WHERE tenant_id = $1 LIMIT 1", [sol])
    )[0]!.id;
    cam = (
      await sql<{ id: string }>(
        "SELECT id FROM cameras WHERE tenant_id = $1 AND code = 'CAM-001'",
        [alfa],
      )
    )[0]!.id;
    const mk = async (email: string, role: string, tenantId: string, password: string) =>
      (
        await api(admin).post("/api/v1/users", { name: email, email, role, tenantId, password })
      ).json().user.id as string;
    await mk("gestor@alfa.test", "tenant_admin", alfa, "GestorAlfa1");
    await mk("gestor@sol.test", "tenant_admin", sol, "GestorSol12");
    viewerId = await mk("vigia@alfa.test", "viewer", alfa, "VigiaAlfa12");
    await api(admin).put(`/api/v1/users/${viewerId}/camera-permissions`, {
      items: [{ cameraId: cam, canLive: true }],
    });
    alfaAdmin = await login("gestor@alfa.test", "GestorAlfa1");
    solAdmin = await login("gestor@sol.test", "GestorSol12");
    await sql(
      `INSERT INTO camera_events (tenant_id, camera_id, type, severity, message)
       VALUES ($1, $2, 'stream_online', 'info', 'histórico da Alfa')`,
      [alfa, cam],
    );
  });

  it("cliente não transfere (só a equipe da plataforma)", async () => {
    const r = await api(alfaAdmin).post(`/api/v1/cameras/${cam}/transfer`, {
      tenantId: sol,
      locationId: solLoc,
    });
    expect(r.statusCode).toBe(403);
  });

  it("valida destino: mesmo cliente e local de outro cliente", async () => {
    const alfaLoc = (
      await sql<{ id: string }>("SELECT id FROM locations WHERE tenant_id = $1 LIMIT 1", [alfa])
    )[0]!.id;
    expect(
      (
        await api(admin).post(`/api/v1/cameras/${cam}/transfer`, {
          tenantId: alfa,
          locationId: alfaLoc,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await api(admin).post(`/api/v1/cameras/${cam}/transfer`, {
          tenantId: sol,
          locationId: alfaLoc,
        })
      ).statusCode,
    ).toBe(400);
  });

  it("transfere mantendo a chave; histórico e permissões ficam para trás", async () => {
    const before = (await api(admin).get(`/api/v1/cameras/${cam}/stream-key`)).json().streamKey;
    const r = await api(admin).post(`/api/v1/cameras/${cam}/transfer`, {
      tenantId: sol,
      locationId: solLoc,
    });
    expect(r.statusCode).toBe(201);
    const moved = r.json().camera;
    expect(r.json().ingest).toBeUndefined();
    expect(moved.tenantId).toBe(sol);
    expect(moved.code).toBe("CAM-002"); // o Sol já tem CAM-001
    expect(moved.id).not.toBe(cam);
    // Mesma chave: o equipamento continua transmitindo sem reconfigurar.
    const after = (await api(admin).get(`/api/v1/cameras/${moved.id}/stream-key`)).json().streamKey;
    expect(after).toBe(before);
    // A antiga saiu da origem.
    expect((await api(admin).get(`/api/v1/cameras/${cam}`)).statusCode).toBe(404);
    expect((await api(alfaAdmin).get(`/api/v1/cameras/${moved.id}`)).statusCode).toBe(404);
    expect(
      (await sql("SELECT 1 FROM user_camera_permissions WHERE camera_id = $1", [cam])).length,
    ).toBe(0);
    // O destino vê a câmera nova, mas não o histórico da origem.
    expect((await api(solAdmin).get(`/api/v1/cameras/${moved.id}`)).statusCode).toBe(200);
    const ev = (await api(solAdmin).get(`/api/v1/events?cameraId=${moved.id}`)).json();
    expect(ev.items.some((e: { message: string }) => e.message === "histórico da Alfa")).toBe(
      false,
    );
    const kept = await sql<{ tenant_id: string }>(
      "SELECT tenant_id FROM camera_events WHERE camera_id = $1 AND message = 'histórico da Alfa'",
      [cam],
    );
    expect(kept.map((k) => k.tenant_id)).toEqual([alfa]);
    // Auditoria nos dois clientes.
    const aud = await sql<{ action: string; tenant_id: string }>(
      "SELECT action, tenant_id FROM audit_logs WHERE action LIKE 'camera.transferred_%' ORDER BY action",
    );
    expect(aud).toEqual([
      { action: "camera.transferred_in", tenant_id: sol },
      { action: "camera.transferred_out", tenant_id: alfa },
    ]);
    cam = moved.id;
  });

  it("com nova chave: devolve a chave nova e a antiga deixa de valer", async () => {
    const before = (await api(admin).get(`/api/v1/cameras/${cam}/stream-key`)).json().streamKey;
    const alfaLoc = (
      await sql<{ id: string }>("SELECT id FROM locations WHERE tenant_id = $1 LIMIT 1", [alfa])
    )[0]!.id;
    const r = await api(admin).post(`/api/v1/cameras/${cam}/transfer`, {
      tenantId: alfa,
      locationId: alfaLoc,
      keepKey: false,
    });
    expect(r.statusCode).toBe(201);
    const key = r.json().ingest.streamKey as string;
    expect(key).not.toBe(before);
    const hits = await sql<{ n: number }>(
      "SELECT count(*)::int AS n FROM cameras WHERE stream_key_hash = $1",
      [hashStreamKey(before)],
    );
    expect(hits[0]!.n).toBe(0);
  });
});
