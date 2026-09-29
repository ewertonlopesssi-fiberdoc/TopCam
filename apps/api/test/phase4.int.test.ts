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

/** Gravação (Fase 4): índice pelos hooks do MediaMTX, resumo, linha do tempo e ajustes. */

let db: TestDb;
let pool: Pool;
let redis: Redis;
let app: FastifyInstance;
const SECRET = randomBytes(24).toString("hex");

beforeAll(async () => {
  db = await createTestDb();
  pool = createPool(db.appUrl, 4);
  redis = new Redis(REDIS_URL);
  await redis.flushdb();
  app = await buildApp({
    env: loadEnv({
      DATABASE_URL: db.appUrl,
      REDIS_URL,
      MEDIA_HOOK_SECRET: SECRET,
      MEDIA_READ_PASSWORD: randomBytes(16).toString("hex"),
      MEDIA_GATEWAY_TOKEN: "gateway-token-de-teste-1234567890",
      STREAM_KEY_ENC_KEY: db.encKeyB64,
      JWT_SECRET: randomBytes(32).toString("hex"),
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

async function login(email: string, password: string) {
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password },
  });
  return r.json().accessToken as string;
}
function api(token: string) {
  const call = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) =>
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
  const t = await login(email, temp);
  await api(t).post("/api/v1/auth/change-password", { currentPassword: temp, newPassword: next });
  return t;
}
function hook(event: string, body: Record<string, unknown>, secret = SECRET) {
  return app.inject({
    method: "POST",
    url: `/internal/mediamtx/hooks/${event}?secret=${secret}`,
    payload: body,
  });
}

let admin = "";
let cam1 = "";
let cam2 = "";
const seg = (cam: string, iso: string) =>
  `/recordings/cam/${cam}/${iso
    .replace("T", "_")
    .replace(/:/g, "-")
    .replace(/\.(\d{3})Z$/, "-$1000")}.mp4`;

beforeAll(async () => {
  admin = await activate("admin@test.local", "senha-de-teste-123", "NovaSenhaForte2026");
  const rows = await ownerQuery<{ id: string; code: string }>(
    db,
    "SELECT c.id, c.code FROM cameras c JOIN tenants t ON t.id = c.tenant_id WHERE t.slug = 'empresa-alfa'",
  );
  cam1 = rows.find((r) => r.code === "CAM-001")!.id;
  cam2 = rows.find((r) => r.code === "CAM-002")!.id;
});

describe("índice pelos hooks do MediaMTX", () => {
  it("início cria o segmento (writing, validade pela retenção); fim registra a duração e agenda a conferência", async () => {
    const path = seg(cam1, "2026-09-29T10:00:00.250Z");
    expect(
      (await hook("segment_create", { path: `cam/${cam1}`, segment_path: path })).statusCode,
    ).toBe(204);
    expect(
      (await hook("segment_create", { path: `cam/${cam1}`, segment_path: path })).statusCode,
    ).toBe(204);
    let rows = await ownerQuery<Record<string, unknown>>(
      db,
      "SELECT path, state, started_at, expires_at, ended_at FROM recording_segments",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      path: `cam/${cam1}/2026-09-29_10-00-00-250000.mp4`,
      state: "writing",
      started_at: new Date("2026-09-29T10:00:00.250Z"),
      expires_at: new Date("2026-09-30T10:00:00.250Z"),
      ended_at: null,
    });
    expect(
      (
        await hook("segment_complete", {
          path: `cam/${cam1}`,
          segment_path: path,
          segment_duration: "1m0.5s",
        })
      ).statusCode,
    ).toBe(204);
    rows = await ownerQuery(db, "SELECT duration_ms, ended_at FROM recording_segments");
    expect(rows[0]).toMatchObject({
      duration_ms: 60500,
      ended_at: new Date("2026-09-29T10:01:00.750Z"),
    });
    const jobs = await ownerQuery<{ payload: { segmentId: string } }>(
      db,
      "SELECT payload FROM durable_jobs WHERE type = 'segment.verify'",
    );
    expect(jobs).toHaveLength(1);
  });

  it("fim sem início (hook perdido) também indexa", async () => {
    const path = seg(cam1, "2026-09-29T10:01:00.750Z");
    expect(
      (
        await hook("segment_complete", {
          path: `cam/${cam1}`,
          segment_path: path,
          segment_duration: "60s",
        })
      ).statusCode,
    ).toBe(204);
    const [r] = await ownerQuery<{ duration_ms: number }>(
      db,
      "SELECT duration_ms FROM recording_segments WHERE path LIKE '%10-01-00-750000.mp4'",
    );
    expect(r!.duration_ms).toBe(60000);
  });

  it("recusa segredo errado, caminhos fora do padrão e câmera que não confere", async () => {
    const ok = seg(cam1, "2026-09-29T11:00:00.000Z");
    expect(
      (await hook("segment_create", { path: `cam/${cam1}`, segment_path: ok }, "errado"))
        .statusCode,
    ).toBe(403);
    for (const bad of [
      `/recordings/cam/${cam1}/../../etc/passwd`,
      `/recordings/live/${"a".repeat(40)}/2026-09-29_11-00-00-000000.mp4`,
      "/tmp/qualquer.mp4",
    ])
      expect(
        (await hook("segment_create", { path: `cam/${cam1}`, segment_path: bad })).statusCode,
        bad,
      ).toBe(400);
    expect(
      (await hook("segment_create", { path: `cam/${cam2}`, segment_path: ok })).statusCode,
    ).toBe(400);
    expect(
      (await hook("segment_other", { path: `cam/${cam1}`, segment_path: ok })).statusCode,
    ).toBe(404);
    const n = await ownerQuery(db, "SELECT 1 FROM recording_segments WHERE path LIKE '%11-00-00%'");
    expect(n).toHaveLength(0);
  });
});

describe("resumo e linha do tempo", () => {
  it("mostram só segmentos conferidos, com lacunas; exigem permissão de reprodução", async () => {
    // Três segmentos conferidos de 60 s com uma lacuna de 30 s entre o 2º e o 3º.
    await ownerQuery(db, "DELETE FROM recording_segments");
    for (const [iso, state] of [
      ["2026-09-29T12:00:00Z", "verified"],
      ["2026-09-29T12:01:00Z", "verified"],
      ["2026-09-29T12:02:30Z", "verified"],
      ["2026-09-29T12:03:30Z", "corrupt"],
    ] as const)
      await ownerQuery(
        db,
        `INSERT INTO recording_segments (tenant_id, camera_id, storage_node_id, path, started_at, ended_at,
                                         duration_ms, size_bytes, state, expires_at)
         SELECT c.tenant_id, c.id, (SELECT id FROM storage_nodes LIMIT 1), $2, $3, $3::timestamptz + interval '60 s',
                60000, 1000000, $4, now() + interval '1 day' FROM cameras c WHERE c.id = $1`,
        [cam1, `cam/${cam1}/${iso}.mp4`, iso, state],
      );
    const a = api(admin);
    const sum = (await a.get(`/api/v1/cameras/${cam1}/recordings/summary`)).json();
    expect(sum).toMatchObject({
      recordingEnabled: true,
      globalEnabled: true,
      retentionHours: 24,
      segments: 3,
      bytes: 3000000,
      corrupt: 1,
      oldest: "2026-09-29T12:00:00.000Z",
      newest: "2026-09-29T12:03:30.000Z",
    });
    const tl = (
      await a.get(
        `/api/v1/cameras/${cam1}/recordings?from=2026-09-29T11:00:00Z&to=2026-09-29T13:00:00Z`,
      )
    ).json();
    expect(tl.segments).toHaveLength(3);
    expect(tl.gaps).toEqual([
      { from: "2026-09-29T12:02:00.000Z", to: "2026-09-29T12:02:30.000Z", seconds: 30 },
    ]);
    expect(
      (
        await a.get(
          `/api/v1/cameras/${cam1}/recordings?from=2026-09-01T00:00:00Z&to=2026-09-29T00:00:00Z`,
        )
      ).statusCode,
    ).toBe(400);

    // Visualizador: ao vivo sim, gravação só com "pode reproduzir".
    const alfa = (
      await ownerQuery<{ id: string }>(db, "SELECT id FROM tenants WHERE slug = 'empresa-alfa'")
    )[0]!.id;
    const v = (
      await a.post("/api/v1/users", {
        name: "Vigia",
        email: "vigia@alfa.test",
        role: "viewer",
        tenantId: alfa,
      })
    ).json();
    const vt = await activate("vigia@alfa.test", v.temporaryPassword, "PortariaSegura2026");
    await a.put(`/api/v1/users/${v.user.id}/camera-permissions`, {
      items: [{ cameraId: cam1, canLive: true }],
    });
    expect((await api(vt).get(`/api/v1/cameras/${cam1}/recordings/summary`)).statusCode).toBe(404);
    expect((await api(vt).get(`/api/v1/cameras/${cam1}/recordings`)).statusCode).toBe(404);
    await a.put(`/api/v1/users/${v.user.id}/camera-permissions`, {
      items: [{ cameraId: cam1, canLive: true, canPlayback: true }],
    });
    expect((await api(vt).get(`/api/v1/cameras/${cam1}/recordings/summary`)).statusCode).toBe(200);
    expect((await api(vt).get(`/api/v1/cameras/${cam2}/recordings/summary`)).statusCode).toBe(404);
  });

  it("trocar a retenção da câmera recalcula a validade das gravações já feitas", async () => {
    const [p] = await ownerQuery<{ id: string }>(
      db,
      "INSERT INTO retention_policies (tenant_id, name, retention_hours) VALUES (NULL, '48 horas', 48) RETURNING id",
    );
    expect(
      (await api(admin).patch(`/api/v1/cameras/${cam1}`, { retentionPolicyId: p!.id })).statusCode,
    ).toBe(200);
    const rows = await ownerQuery<{ started_at: Date; expires_at: Date }>(
      db,
      "SELECT started_at, expires_at FROM recording_segments WHERE state = 'verified'",
    );
    for (const r of rows)
      expect(r.expires_at.getTime() - r.started_at.getTime()).toBe(48 * 3600_000);
  });
});

describe("chave geral da gravação", () => {
  it("só o Super Admin muda; reconcilia o servidor de mídia e fica na auditoria", async () => {
    const a = api(admin);
    expect((await a.put("/api/v1/settings", { recordingGloballyEnabled: false })).statusCode).toBe(
      200,
    );
    expect((await a.get("/api/v1/settings")).json().recordingGloballyEnabled).toBe(false);
    const jobs = await ownerQuery(
      db,
      "SELECT 1 FROM durable_jobs WHERE type = 'mediamtx.reconcile' AND status = 'pending'",
    );
    expect(jobs.length).toBeGreaterThan(0);
    const [aud] = await ownerQuery<{ data: { changes: Record<string, unknown> } }>(
      db,
      "SELECT data FROM audit_logs WHERE action = 'settings.updated' ORDER BY id DESC LIMIT 1",
    );
    expect(aud!.data.changes["recording.globally_enabled"]).toBe(false);
    expect((await a.put("/api/v1/settings", { recordingGloballyEnabled: true })).statusCode).toBe(
      200,
    );
  });
});
