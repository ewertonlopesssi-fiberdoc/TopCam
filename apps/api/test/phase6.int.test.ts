import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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

/** Armazenamento e servidores (Fase 6): API, permissões, limites e buracos na linha do tempo. */

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
async function activate(email: string, temp: string, next: string) {
  const t = await login(email, temp);
  await api(t).post("/api/v1/auth/change-password", { currentPassword: temp, newPassword: next });
  return t;
}

let admin = "";
let operator = "";
let tenantAdmin = "";
let cam1 = "";
let node = "";
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

beforeAll(async () => {
  admin = await activate("admin@test.local", "senha-de-teste-123", "NovaSenhaForte2026");
  const [r] = await ownerQuery<{ id: string; tenant_id: string; storage_node_id: string }>(
    db,
    `SELECT c.id, c.tenant_id, c.storage_node_id FROM cameras c JOIN tenants t ON t.id = c.tenant_id
      WHERE t.slug = 'empresa-alfa' AND c.code = 'CAM-001'`,
  );
  cam1 = r!.id;
  node = r!.storage_node_id;
  const op = (
    await api(admin).post("/api/v1/users", {
      name: "Oper",
      email: "oper@plat.test",
      role: "platform_operator",
    })
  ).json();
  operator = await activate("oper@plat.test", op.temporaryPassword, "Plataforma-Leitura-2026");
  const ta = (
    await api(admin).post("/api/v1/users", {
      name: "Adm Alfa",
      email: "adm@alfa.test",
      role: "tenant_admin",
      tenantId: r!.tenant_id,
    })
  ).json();
  tenantAdmin = await activate("adm@alfa.test", ta.temporaryPassword, "Gestao-Cliente-2026");
  // Segmento de 60 s com um buraco de 20 s a 30 s (quadros perdidos).
  await ownerQuery(
    db,
    `INSERT INTO recording_segments (tenant_id, camera_id, storage_node_id, path, started_at, ended_at, duration_ms,
                                     size_bytes, state, expires_at, holes)
     SELECT c.tenant_id, c.id, c.storage_node_id, 'cam/' || c.id || '/h.mp4', $2::timestamptz,
            $2::timestamptz + interval '60 s', 60000, 5000000, 'verified', now() + interval '1 day',
            '[{"from": 20, "to": 30}]'::jsonb
       FROM cameras c WHERE c.id = $1`,
    [cam1, iso(now - 10 * 60_000)],
  );
});

describe("permissões", () => {
  it("plataforma lê; só o Super Admin altera; clientes não veem", async () => {
    expect((await api(admin).get("/api/v1/storage")).statusCode).toBe(200);
    expect((await api(operator).get("/api/v1/storage")).statusCode).toBe(200);
    expect((await api(operator).get("/api/v1/servers")).statusCode).toBe(200);
    expect(
      (await api(operator).patch(`/api/v1/storage/nodes/${node}`, { warnPct: 60 })).statusCode,
    ).toBe(403);
    expect(
      (await api(operator).put("/api/v1/storage/settings", { emergencyPurge: false })).statusCode,
    ).toBe(403);
    expect((await api(tenantAdmin).get("/api/v1/storage")).statusCode).toBe(403);
    expect((await api(tenantAdmin).get("/api/v1/servers")).statusCode).toBe(403);
  });
});

describe("armazenamento", () => {
  it("resumo: discos, clientes, câmeras e configurações", async () => {
    const s = (await api(admin).get("/api/v1/storage")).json();
    expect(s.nodes).toHaveLength(1);
    expect(s.nodes[0]).toMatchObject({
      id: node,
      warnPct: 70,
      highPct: 85,
      criticalPct: 95,
      recordingBlocked: false,
    });
    expect(s.settings).toEqual({ emergencyPurge: true, purgeMinAgeMinutes: 60 });
    const cam = s.cameras.find((c: { id: string }) => c.id === cam1);
    expect(cam).toMatchObject({ code: "CAM-001", bytes: 5000000, segments: 1 });
    expect(s.tenants.find((t: { name: string }) => t.name === "Empresa Alfa").usedBytes).toBe(
      5000000,
    );
  });

  it("limites crescentes, cota em GB e configurações, tudo na auditoria", async () => {
    const a = api(admin);
    expect((await a.patch(`/api/v1/storage/nodes/${node}`, { warnPct: 90 })).statusCode).toBe(400);
    expect(
      (
        await a.patch(`/api/v1/storage/nodes/${node}`, {
          warnPct: 60,
          highPct: 80,
          criticalPct: 92,
          quotaGb: 30,
        })
      ).statusCode,
    ).toBe(200);
    let [n] = await ownerQuery<{ warn_pct: number; critical_pct: number; quota_bytes: string }>(
      db,
      "SELECT warn_pct, critical_pct, quota_bytes::text FROM storage_nodes WHERE id = $1",
      [node],
    );
    expect(n).toMatchObject({
      warn_pct: 60,
      critical_pct: 92,
      quota_bytes: String(30e9),
    });
    await a.patch(`/api/v1/storage/nodes/${node}`, {
      quotaGb: null,
      warnPct: 70,
      highPct: 85,
      criticalPct: 95,
    });
    [n] = await ownerQuery(
      db,
      "SELECT warn_pct, critical_pct, quota_bytes::text FROM storage_nodes WHERE id = $1",
      [node],
    );
    expect(n!.quota_bytes).toBeNull();
    expect((await a.put("/api/v1/storage/settings", { purgeMinAgeMinutes: -1 })).statusCode).toBe(
      400,
    );
    expect(
      (await a.put("/api/v1/storage/settings", { emergencyPurge: false, purgeMinAgeMinutes: 120 }))
        .statusCode,
    ).toBe(200);
    expect((await a.get("/api/v1/storage")).json().settings).toEqual({
      emergencyPurge: false,
      purgeMinAgeMinutes: 120,
    });
    await a.put("/api/v1/storage/settings", { emergencyPurge: true, purgeMinAgeMinutes: 60 });
    const audits = await ownerQuery<{ action: string }>(
      db,
      "SELECT action FROM audit_logs WHERE action IN ('storage.node_updated', 'settings.updated') ORDER BY id",
    );
    expect(audits.map((x) => x.action)).toEqual([
      "storage.node_updated",
      "storage.node_updated",
      "settings.updated",
      "settings.updated",
    ]);
  });

  it("servidores: métricas do servidor gravadas pelo worker", async () => {
    await ownerQuery(
      db,
      `UPDATE ingest_nodes SET metrics = '{"paths_ready": 2, "host": {"cpu_pct": 12.5, "system_disk": {"pct": 40}}}'::jsonb
        WHERE name = 'ingest-01'`,
    );
    const s = (await api(admin).get("/api/v1/servers")).json();
    expect(s.items[0]).toMatchObject({ name: "ingest-01", metrics: { host: { cpu_pct: 12.5 } } });
  });
});

describe("buracos dentro de segmentos", () => {
  it("aparecem como lacuna na linha do tempo e dividem a exportação em blocos", async () => {
    const tl = (
      await api(admin).get(
        `/api/v1/cameras/${cam1}/recordings?from=${iso(now - 20 * 60_000)}&to=${iso(now)}`,
      )
    ).json();
    expect(tl.segments[0].holes).toEqual([{ from: 20, to: 30 }]);
    expect(tl.gaps).toEqual([
      {
        from: iso(now - 10 * 60_000 + 20_000),
        to: iso(now - 10 * 60_000 + 30_000),
        seconds: 10,
        internal: true,
      },
    ]);
    const ex = (
      await api(admin).post(`/api/v1/cameras/${cam1}/exports`, {
        start: iso(now - 10 * 60_000),
        end: iso(now - 9 * 60_000),
      })
    ).json();
    const before = mtxRequests.length;
    const dl = await app.inject({ method: "GET", url: ex.downloadUrl });
    expect(dl.statusCode).toBe(200);
    const parts = mtxRequests.slice(before);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain("&duration=20&format=mp4");
    expect(parts[1]).toContain(
      `start=${encodeURIComponent(iso(now - 10 * 60_000 + 30_005))}&duration=30&format=mp4`,
    );
  });
});
