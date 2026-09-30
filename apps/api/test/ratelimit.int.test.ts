import { randomBytes } from "node:crypto";
import { createPool, type Pool } from "@topcam/db";
import {
  decryptStreamKey,
  mediaPathForKey,
  parseEncryptionKey,
  type MediaMtxClient,
} from "@topcam/shared";
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
 * Limites (Fase 8): geral por IP na API (redes confiáveis de fora), por ação sensível
 * (por usuário) e bloqueio de IP que erra chave de câmera (câmera certa continua entrando).
 */

const SECRET = randomBytes(24).toString("hex");
let db: TestDb;
let pool: Pool;
let redis: Redis;
let app: FastifyInstance;
let camKey = "";

beforeAll(async () => {
  db = await createTestDb();
  pool = createPool(db.appUrl, 4);
  redis = new Redis(REDIS_URL);
  // Rede do "firewall" gravada antes do primeiro acesso (o cache é de 1 min).
  await ownerQuery(
    db,
    "INSERT INTO firewall_ssh_networks (cidr, description) VALUES ('198.51.100.0/24', 'escritório')",
  );
  app = await buildApp({
    env: loadEnv({
      DATABASE_URL: db.appUrl,
      REDIS_URL,
      MEDIA_HOOK_SECRET: SECRET,
      MEDIA_READ_PASSWORD: randomBytes(16).toString("hex"),
      MEDIA_GATEWAY_TOKEN: "gateway-token-de-teste-1234567890",
      STREAM_KEY_ENC_KEY: db.encKeyB64,
      JWT_SECRET: randomBytes(32).toString("hex"),
      RATE_LIMIT_API_PER_MIN: "5",
      PUBLISH_BADKEY_MAX: "3",
      PUBLISH_BADKEY_BLOCK_S: "600",
      LOG_LEVEL: "silent",
    }),
    pool,
    redis,
    mediamtx: { listPaths: async () => [], getPath: async () => null } as unknown as MediaMtxClient,
  });
  const enc = (
    await ownerQuery<{ stream_key_enc: string }>(
      db,
      "SELECT stream_key_enc FROM cameras WHERE code = 'CAM-001' LIMIT 1",
    )
  )[0]!.stream_key_enc;
  camKey = decryptStreamKey(enc, parseEncryptionKey(db.encKeyB64));
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  redis?.disconnect();
  await db?.drop();
});

const from = (ip: string, url = "/api/v1/auth/me") =>
  app.inject({ method: "GET", url, headers: { "x-forwarded-for": ip } });

describe("limite geral por IP", () => {
  it("passa do limite → 429 em português, Retry-After e um evento só", async () => {
    const ip = "203.0.113.50";
    for (let i = 0; i < 5; i++) expect((await from(ip)).statusCode).toBe(401);
    const r = await from(ip);
    expect(r.statusCode).toBe(429);
    expect(r.json().message).toMatch(/Muitas solicitações deste endereço\. Aguarde \d+ segundos/);
    expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
    await from(ip);
    const ev = await ownerQuery(
      db,
      "SELECT 1 FROM camera_events WHERE type = 'rate_limited' AND host(source_ip) = $1",
      [ip],
    );
    expect(ev).toHaveLength(1);
    // Outro IP não é afetado.
    expect((await from("203.0.113.51")).statusCode).toBe(401);
  });

  it("não limita health, rede interna/Docker, loopback nem as redes do firewall", async () => {
    for (let i = 0; i < 8; i++) {
      expect((await from("203.0.113.60", "/api/v1/health")).statusCode).toBe(200);
      expect((await from("172.31.141.99")).statusCode).toBe(401);
      expect((await from("198.51.100.7")).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/api/v1/auth/me" })).statusCode).toBe(401);
    }
  });
});

describe("limite por ação sensível", () => {
  it("troca de senha: 10 por 15 min por usuário", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "admin@test.local", password: "senha-de-teste-123" },
    });
    const token = login.json().accessToken as string;
    const change = () =>
      app.inject({
        method: "POST",
        url: "/api/v1/auth/change-password",
        headers: { authorization: `Bearer ${token}` },
        payload: { currentPassword: "errada-errada-1", newPassword: "NovaSenha2026" },
      });
    for (let i = 0; i < 10; i++) expect((await change()).statusCode).not.toBe(429);
    const r = await change();
    expect(r.statusCode).toBe(429);
    expect(r.json().message).toMatch(/Muitas solicitações desta ação\. Aguarde \d+ minutos/);
  });
});

describe("chave de câmera errada: bloqueio temporário do IP", () => {
  const auth = (path: string, ip: string) =>
    app.inject({
      method: "POST",
      url: `/internal/mediamtx/auth?secret=${SECRET}`,
      payload: {
        user: "",
        password: "",
        ip,
        action: "publish",
        path,
        protocol: "rtmp",
        id: null,
        query: "",
      },
    });
  const bad = (n: number) => `live/${"x".repeat(30)}${String(n).padStart(10, "0")}`;

  it("3 erros → bloqueia, registra evento e alerta; depois recusa sem registrar", async () => {
    const ip = "203.0.113.77";
    for (let i = 0; i < 3; i++) expect((await auth(bad(i), ip)).statusCode).toBe(401);
    const blocked = await ownerQuery<{ message: string }>(
      db,
      "SELECT message FROM camera_events WHERE type = 'publish_ip_blocked' AND host(source_ip) = $1",
      [ip],
    );
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.message).toMatch(/recusadas por 10 min/);
    const alert = await ownerQuery(
      db,
      "SELECT 1 FROM alerts WHERE dedup_key = $1 AND status = 'open'",
      [`security.publish_ip_blocked:${ip}`],
    );
    expect(alert).toHaveLength(1);

    const before = await ownerQuery<{ n: string }>(
      db,
      "SELECT count(*) AS n FROM camera_events WHERE type = 'auth_rejected' AND host(source_ip) = $1",
      [ip],
    );
    for (let i = 3; i < 8; i++) expect((await auth(bad(i), ip)).statusCode).toBe(401);
    const after = await ownerQuery<{ n: string }>(
      db,
      "SELECT count(*) AS n FROM camera_events WHERE type = 'auth_rejected' AND host(source_ip) = $1",
      [ip],
    );
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("câmera com a chave certa no mesmo IP bloqueado continua entrando", async () => {
    const r = await auth(mediaPathForKey(camKey), "203.0.113.77");
    expect(r.statusCode).toBe(200);
  });

  it("outro IP não é afetado pelo bloqueio", async () => {
    expect((await auth(bad(99), "203.0.113.78")).statusCode).toBe(401);
    const ev = await ownerQuery(
      db,
      "SELECT 1 FROM camera_events WHERE type = 'publish_ip_blocked' AND host(source_ip) = '203.0.113.78'",
    );
    expect(ev).toHaveLength(0);
  });
});
