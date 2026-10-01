import { randomBytes } from "node:crypto";
import { createPool, type Pool } from "@topcam/db";
import type { MediaMtxClient } from "@topcam/shared";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { PLATFORM, findCameraBySmtpLogin, withScope } from "@topcam/db";
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
 * Movimento e alarme no cadastro da câmera (API): validações, credencial de eventos,
 * linha do tempo com movimento e trechos sem movimento, e transferência.
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
let gestor = "";
let alfa = "";
let cam = "";

const sql = <T extends Record<string, unknown>>(q: string, p: unknown[] = []) =>
  ownerQuery<T & import("pg").QueryResultRow>(db, q, p);

beforeAll(async () => {
  const t = await login("admin@test.local", "senha-de-teste-123");
  await api(t).post("/api/v1/auth/change-password", {
    currentPassword: "senha-de-teste-123",
    newPassword: "NovaSenha2026",
  });
  admin = await login("admin@test.local", "NovaSenha2026");
  alfa = (await sql<{ id: string }>("SELECT id FROM tenants WHERE slug = 'empresa-alfa'"))[0]!.id;
  cam = (
    await sql<{ id: string }>("SELECT id FROM cameras WHERE tenant_id = $1 AND code = 'CAM-003'", [
      alfa,
    ])
  )[0]!.id;
  await api(admin).post("/api/v1/users", {
    name: "Gestor",
    email: "gestor@alfa.test",
    role: "tenant_admin",
    tenantId: alfa,
    password: "GestorAlfa1",
  });
  gestor = await login("gestor@alfa.test", "GestorAlfa1");
});

describe("cadastro: movimento e alarme", () => {
  it("gravação só com movimento e alarme exigem a origem do movimento", async () => {
    const a = await api(admin).patch(`/api/v1/cameras/${cam}`, {
      recordingEnabled: true,
      recordingMode: "motion",
    });
    expect(a.statusCode).toBe(400);
    expect(a.json().message).toMatch(/detecção de movimento/);
    const b = await api(admin).patch(`/api/v1/cameras/${cam}`, { alarmEnabled: true });
    expect(b.statusCode).toBe(400);
  });

  it("horário inválido é recusado", async () => {
    const r = await api(admin).patch(`/api/v1/cameras/${cam}`, {
      motionSource: "server",
      alarmEnabled: true,
      alarmSchedule: { rules: [{ days: [1], from: "25:00", to: "06:00" }] },
    });
    expect(r.statusCode).toBe(400);
  });

  it("salva modo, origem, sensibilidade, alarme e horários", async () => {
    const r = await api(admin).patch(`/api/v1/cameras/${cam}`, {
      recordingEnabled: true,
      recordingMode: "motion",
      motionSource: "server",
      motionSensitivity: 7,
      alarmEnabled: true,
      alarmSchedule: { rules: [{ days: [5, 1, 5], from: "22:00", to: "06:00" }] },
      alarmCooldownS: 900,
      alarmEmail: false,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      recordingEnabled: true,
      recordingMode: "motion",
      motionSource: "server",
      motionSensitivity: 7,
      alarmEnabled: true,
      alarmSchedule: { rules: [{ days: [1, 5], from: "22:00", to: "06:00" }] },
      alarmCooldownS: 900,
      alarmEmail: false,
    });
    // Só a parte informada muda: trocar a sensibilidade mantém o resto.
    const r2 = await api(admin).patch(`/api/v1/cameras/${cam}`, { motionSensitivity: 3 });
    expect(r2.json()).toMatchObject({
      motionSensitivity: 3,
      alarmCooldownS: 900,
      alarmEnabled: true,
    });
  });

  it("cliente não altera o cadastro da câmera (só a equipe da plataforma)", async () => {
    const r = await api(gestor).patch(`/api/v1/cameras/${cam}`, { alarmEnabled: false });
    expect(r.statusCode).toBe(403);
  });

  it("voltar para contínua libera o que estava em espera", async () => {
    const node = (await sql<{ id: string }>("SELECT id FROM storage_nodes LIMIT 1"))[0]!.id;
    await sql(
      `INSERT INTO recording_segments (tenant_id, camera_id, storage_node_id, path, started_at, ended_at, duration_ms, state, expires_at, motion_hold)
       VALUES ($1, $2, $3, 'cam/mov/espera.mp4', now() - interval '10 minutes', now() - interval '9 minutes', 60000, 'verified', now() + interval '50 minutes', true)`,
      [alfa, cam, node],
    );
    await api(admin).patch(`/api/v1/cameras/${cam}`, { recordingMode: "continuous" });
    const s = await sql<{ motion_hold: boolean; hours: number }>(
      "SELECT motion_hold, extract(epoch FROM expires_at - started_at) / 3600 AS hours FROM recording_segments WHERE path = 'cam/mov/espera.mp4'",
    );
    expect(s[0]!.motion_hold).toBe(false);
    expect(Number(s[0]!.hours)).toBeGreaterThan(23);
    await api(admin).patch(`/api/v1/cameras/${cam}`, { recordingMode: "motion" });
  });
});

describe("credencial de eventos (e-mail da câmera)", () => {
  it("só a equipe da plataforma gera; a senha aparece uma vez e o banco guarda o hash", async () => {
    expect((await api(gestor).post(`/api/v1/cameras/${cam}/motion-credential`)).statusCode).toBe(
      403,
    );
    const r = await api(admin).post(`/api/v1/cameras/${cam}/motion-credential`);
    expect(r.statusCode).toBe(200);
    const { smtp } = r.json();
    expect(smtp).toMatchObject({ port: 2525 });
    expect(smtp.user).toMatch(/^cam[a-z0-9]{9}$/);
    expect(smtp.password).toMatch(/^[A-Za-z0-9]{24}$/);
    const row = (
      await sql<{ motion_smtp_hash: string }>(
        "SELECT motion_smtp_hash FROM cameras WHERE id = $1",
        [cam],
      )
    )[0]!;
    expect(row.motion_smtp_hash).not.toContain(smtp.password);
    // A credencial reconhece a câmera (o receptor de eventos usa esta mesma função).
    const found = await withScope(pool, PLATFORM, (c) =>
      findCameraBySmtpLogin(c, smtp.user, smtp.password),
    );
    expect(found?.id).toBe(cam);
    expect(
      await withScope(pool, PLATFORM, (c) => findCameraBySmtpLogin(c, smtp.user, "errada")),
    ).toBeNull();
    // Auditoria sem a senha.
    const a = await sql<{ data: unknown }>(
      "SELECT data FROM audit_logs WHERE action = 'camera.motion_credential_rotated'",
    );
    expect(JSON.stringify(a)).not.toContain(smtp.password);
  });

  it("o cliente vê só que existe credencial, não o usuário", async () => {
    const g = (await api(gestor).get(`/api/v1/cameras/${cam}`)).json();
    expect(g.motionCredential).toBe(true);
    expect(g.motionSmtpUser).toBeUndefined();
    const a = (await api(admin).get(`/api/v1/cameras/${cam}`)).json();
    expect(a.motionSmtpUser).toMatch(/^cam/);
  });
});

describe("linha do tempo com movimento", () => {
  it("marca os movimentos e não chama de lacuna o que foi apagado por falta de movimento", async () => {
    const node = (await sql<{ id: string }>("SELECT id FROM storage_nodes LIMIT 1"))[0]!.id;
    const base = Date.now() - 3 * 3600_000;
    const t = (s: number) => new Date(base + s * 1000);
    const seg = (name: string, s: number, state: string, reason: string | null) =>
      sql(
        `INSERT INTO recording_segments (tenant_id, camera_id, storage_node_id, path, started_at, ended_at, duration_ms, state, expires_at, deleted_reason)
         VALUES ($1, $2, $3, $4, $5, $6, 60000, $7, now() + interval '1 day', $8)`,
        [alfa, cam, node, `cam/tl/${name}.mp4`, t(s), t(s + 60), state, reason],
      );
    await seg("1", 0, "deleted", "no_motion");
    await seg("2", 60, "verified", null);
    await seg("3", 120, "deleted", "no_motion");
    await seg("4", 180, "deleted", "no_motion");
    await seg("5", 240, "verified", null);
    // Lacuna de verdade (sinal) depois: 5 min sem nada.
    await seg("6", 600, "verified", null);
    await sql(
      `INSERT INTO motion_events (tenant_id, camera_id, source, kind, started_at, ended_at)
       VALUES ($1, $2, 'server', 'motion', $3, $4), ($1, $2, 'camera', 'human', $5, $6)`,
      [alfa, cam, t(70), t(90), t(250), t(260)],
    );
    const r = await api(admin).get(
      `/api/v1/cameras/${cam}/recordings?from=${encodeURIComponent(t(-60).toISOString())}&to=${encodeURIComponent(t(700).toISOString())}`,
    );
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.segments.length).toBe(3);
    expect(j.motion.map((m: { kind: string }) => m.kind)).toEqual(["motion", "human"]);
    expect(j.noMotion).toEqual([
      { from: t(0).toISOString(), to: t(60).toISOString() },
      { from: t(120).toISOString(), to: t(240).toISOString() },
    ]);
    // Só a lacuna real (300 s → 600 s).
    expect(j.gaps.map((g: { seconds: number }) => g.seconds)).toEqual([300]);
  });
});

describe("transferência", () => {
  it("mantendo a chave, movimento, alarme e credencial vão para a câmera nova", async () => {
    const sol = (
      await sql<{ id: string }>("SELECT id FROM tenants WHERE slug = 'condominio-sol'")
    )[0]!.id;
    const solLoc = (
      await sql<{ id: string }>("SELECT id FROM locations WHERE tenant_id = $1 LIMIT 1", [sol])
    )[0]!.id;
    const before = (
      await sql<{ motion_smtp_user: string }>(
        "SELECT motion_smtp_user FROM cameras WHERE id = $1",
        [cam],
      )
    )[0]!.motion_smtp_user;
    const r = await api(admin).post(`/api/v1/cameras/${cam}/transfer`, {
      tenantId: sol,
      locationId: solLoc,
    });
    expect(r.statusCode).toBe(201);
    const n = r.json().camera;
    expect(n).toMatchObject({
      recordingMode: "motion",
      motionSource: "server",
      alarmEnabled: true,
      alarmCooldownS: 900,
      motionSmtpUser: before,
    });
    const old = (
      await sql<{ motion_smtp_user: string | null }>(
        "SELECT motion_smtp_user FROM cameras WHERE id = $1",
        [cam],
      )
    )[0]!;
    expect(old.motion_smtp_user).toBeNull();
  });
});
