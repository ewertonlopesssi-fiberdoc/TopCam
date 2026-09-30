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
 * Firewall (Fase 8): o painel mantém a lista de redes do SSH; só o Super Admin mexe;
 * a lista nunca fica vazia; o status vem do serviço do host (system_settings).
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
let alfaAdmin = "";

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
  alfaAdmin = await login("gestor@alfa.test", "GestorAlfa1");
});

const URL = "/api/v1/firewall/ssh-networks";

describe("firewall: redes liberadas para o SSH", () => {
  let first = "";

  it("sem o serviço do host: lista vazia e status not_installed", async () => {
    const r = await api(admin).get("/api/v1/firewall");
    expect(r.statusCode).toBe(200);
    expect(r.json().networks).toEqual([]);
    expect(r.json().status.state).toBe("not_installed");
    expect(r.json().publicPorts.map((p: { port: string }) => p.port)).toContain("443/tcp");
  });

  it("cliente não vê nem altera o firewall", async () => {
    expect((await api(alfaAdmin).get("/api/v1/firewall")).statusCode).toBe(403);
    expect(
      (await api(alfaAdmin).post(URL, { cidr: "10.0.0.0/8", description: "x" })).statusCode,
    ).toBe(403);
  });

  it("cadastra, normaliza e audita", async () => {
    const r = await api(admin).post(URL, { cidr: "172.31.141.20/16", description: "Rede interna" });
    expect(r.statusCode).toBe(201);
    expect(r.json().cidr).toBe("172.31.0.0/16");
    first = r.json().id;
    const ip = await api(admin).post(URL, { cidr: "45.237.164.6", description: "um IP" });
    expect(ip.json().cidr).toBe("45.237.164.6/32");
    const a = await ownerQuery<{ data: { cidr: string } }>(
      db,
      "SELECT data FROM audit_logs WHERE action = 'firewall.rule_created' ORDER BY id",
    );
    expect(a.map((x) => x.data.cidr)).toEqual(["172.31.0.0/16", "45.237.164.6/32"]);
  });

  it("recusa rede inválida, ampla demais ou repetida (mensagens em português)", async () => {
    for (const [cidr, msg] of [
      ["0.0.0.0/0", /mínimo é \/8/],
      ["10.0.0.0/7", /mínimo é \/8/],
      ["300.1.1.1/24", /IP inválido/],
      ["abc", /Rede inválida/],
      ["::/0", /mínimo em IPv6/],
    ] as const) {
      const r = await api(admin).post(URL, { cidr, description: "" });
      expect(r.statusCode, cidr).toBe(400);
      expect(r.json().message).toMatch(msg);
    }
    const dup = await api(admin).post(URL, { cidr: "172.31.5.5/16", description: "" });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().message).toMatch(/já está na lista/);
  });

  it("edita IP/máscara e descrição", async () => {
    const r = await api(admin).patch(`${URL}/${first}`, {
      cidr: "100.65.0.0/21",
      description: "CGNAT",
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ cidr: "100.65.0.0/21", description: "CGNAT" });
    expect((await api(admin).patch(`${URL}/999999`, { description: "x" })).statusCode).toBe(404);
  });

  it("não deixa remover a última rede", async () => {
    const list = (await api(admin).get("/api/v1/firewall")).json().networks as { id: string }[];
    expect(list).toHaveLength(2);
    expect((await api(admin).del(`${URL}/${list[1]!.id}`)).statusCode).toBe(204);
    const last = await api(admin).del(`${URL}/${list[0]!.id}`);
    expect(last.statusCode).toBe(409);
    expect(last.json().message).toMatch(/última rede/);
    const del = await ownerQuery(
      db,
      "SELECT 1 FROM audit_logs WHERE action = 'firewall.rule_deleted'",
    );
    expect(del).toHaveLength(1);
  });

  it("status vem do serviço do host: aplicado, pendente, erro e parado", async () => {
    const put = (v: unknown) =>
      ownerQuery(
        db,
        `INSERT INTO system_settings (key, value) VALUES ('firewall.status', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [JSON.stringify(v)],
      );
    const now = new Date().toISOString();
    const state = async () => (await api(admin).get("/api/v1/firewall")).json().status;

    await put({ ok: true, applied_at: now, checked_at: now, networks: ["100.65.0.0/21"] });
    expect((await state()).state).toBe("applied");

    await api(admin).post(URL, { cidr: "100.66.0.0/21", description: "CGNAT 2" });
    expect((await state()).state).toBe("pending");

    await put({ ok: false, error: "regras recusadas", checked_at: now });
    expect(await state()).toMatchObject({ state: "error", error: "regras recusadas" });

    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    await put({ ok: true, applied_at: old, checked_at: old, networks: [] });
    expect((await state()).state).toBe("stale");
  });
});
