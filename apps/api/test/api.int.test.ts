import { randomBytes } from "node:crypto";
import { createPool, type Pool } from "@topcam/db";
import {
  decryptStreamKey,
  generateStreamKey,
  mediaPathForKey,
  parseEncryptionKey,
  type MediaMtxClient,
  type MtxPath,
} from "@topcam/shared";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  REDIS_URL,
  createTestDb,
  ownerQuery,
  type TestDb,
} from "../../../packages/db/test/helpers.js";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";

const SECRET = randomBytes(24).toString("hex");
const READ_PASS = randomBytes(16).toString("hex");

let db: TestDb;
let pool: Pool;
let redis: Redis;
let app: FastifyInstance;
let pathState: Record<string, Partial<MtxPath> | null> = {};
let keys: Record<string, string> = {};

const fakeMediaMtx = {
  getPath: async (name: string) => (pathState[name] as MtxPath | undefined) ?? null,
  listPaths: async () => [],
} as unknown as MediaMtxClient;

beforeAll(async () => {
  db = await createTestDb();
  pool = createPool(db.appUrl, 4);
  redis = new Redis(REDIS_URL);
  const env = loadEnv({
    DATABASE_URL: db.appUrl,
    REDIS_URL,
    MEDIA_HOOK_SECRET: SECRET,
    MEDIA_READ_PASSWORD: READ_PASS,
    STREAM_KEY_ENC_KEY: db.encKeyB64,
    LOG_LEVEL: "silent",
  });
  app = await buildApp({ env, pool, redis, mediamtx: fakeMediaMtx });
  const encKey = parseEncryptionKey(db.encKeyB64);
  const rows = await ownerQuery<{ slug: string; code: string; stream_key_enc: string }>(
    db,
    "SELECT t.slug, c.code, c.stream_key_enc FROM cameras c JOIN tenants t ON t.id = c.tenant_id",
  );
  keys = Object.fromEntries(
    rows.map((r) => [`${r.slug}/${r.code}`, decryptStreamKey(r.stream_key_enc, encKey)]),
  );
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  redis?.disconnect();
  await db?.drop();
});

beforeEach(async () => {
  pathState = {};
  await redis.flushdb();
});

function auth(body: Record<string, unknown>, secret = SECRET) {
  return app.inject({
    method: "POST",
    url: `/internal/mediamtx/auth?secret=${secret}`,
    payload: body,
  });
}

function hook(event: string, path: string) {
  return app.inject({
    method: "POST",
    url: `/internal/mediamtx/hooks/${event}?secret=${SECRET}`,
    payload: { path, source_type: "rtmpConn", source_id: "x" },
  });
}

async function camera(code: string, slug = "empresa-alfa") {
  return (
    await ownerQuery<{
      id: string;
      status: string;
      last_publish_ip: string | null;
      last_video_at: Date | null;
    }>(
      db,
      `SELECT c.id, c.status, host(c.last_publish_ip) AS last_publish_ip, c.last_video_at
       FROM cameras c JOIN tenants t ON t.id = c.tenant_id WHERE t.slug = $1 AND c.code = $2`,
      [slug, code],
    )
  )[0]!;
}

async function events(type: string) {
  return ownerQuery<{
    camera_id: string | null;
    tenant_id: string | null;
    source_ip: string | null;
    data: Record<string, unknown>;
  }>(
    db,
    "SELECT camera_id, tenant_id, host(source_ip) AS source_ip, data FROM camera_events WHERE type = $1 ORDER BY id",
    [type],
  );
}

const publish = (path: string, ip = "203.0.113.10", protocol = "rtmp") => ({
  user: "",
  password: "",
  ip,
  action: "publish",
  path,
  protocol,
  id: null,
  query: "",
});

describe("saúde", () => {
  it("/health, /ready e /api/v1/health", async () => {
    expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
    const ready = await app.inject({ url: "/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().checks).toMatchObject({ database: "ok", redis: "ok", mediamtx: "ok" });
    expect((await app.inject({ url: "/api/v1/health" })).json()).toMatchObject({ status: "ok" });
  });
});

describe("autenticação de publicação (MediaMTX → API)", () => {
  it("rota interna exige o segredo", async () => {
    const res = await auth(
      publish(mediaPathForKey(keys["empresa-alfa/CAM-001"]!)),
      "errado".repeat(8),
    );
    expect(res.statusCode).toBe(403);
  });

  it("aceita a chave válida e marca a câmera como conectando", async () => {
    const res = await auth(publish(mediaPathForKey(keys["empresa-alfa/CAM-002"]!)));
    expect(res.statusCode).toBe(200);
    const cam = await camera("CAM-002");
    expect(cam.status).toBe("conectando");
    expect(cam.last_publish_ip).toBe("203.0.113.10");
    const ev = await events("publish_authorized");
    expect(ev.some((e) => e.camera_id === cam.id)).toBe(true);
  });

  it("recusa chave inválida, registra IP e suprime repetições na janela", async () => {
    const before = (await events("auth_rejected")).length;
    const path = mediaPathForKey(generateStreamKey());
    expect((await auth(publish(path, "198.51.100.7"))).statusCode).toBe(401);
    expect((await auth(publish(path, "198.51.100.7"))).statusCode).toBe(401);
    const ev = await events("auth_rejected");
    expect(ev.length).toBe(before + 1);
    expect(ev.at(-1)).toMatchObject({
      source_ip: "198.51.100.7",
      tenant_id: null,
      camera_id: null,
    });
    expect(JSON.stringify(ev.at(-1)!.data)).not.toContain(path.slice(5));
  });

  it("recusa caminho fora do padrão", async () => {
    expect((await auth(publish("outro/caminho"))).statusCode).toBe(401);
    expect((await events("auth_rejected")).some((e) => e.data.reason === "invalid_path")).toBe(
      true,
    );
  });

  it("recusa publicação simultânea na mesma chave (sem consultar o MediaMTX)", async () => {
    await ownerQuery(
      db,
      `UPDATE cameras SET status = 'ao_vivo', last_video_at = now()
      WHERE code = 'CAM-003' AND tenant_id = (SELECT id FROM tenants WHERE slug = 'empresa-alfa')`,
    );
    const path = mediaPathForKey(keys["empresa-alfa/CAM-003"]!);
    expect((await auth(publish(path, "198.51.100.8"))).statusCode).toBe(401);
    const cam = await camera("CAM-003");
    expect(cam.status).toBe("ao_vivo");
    const ev = await events("duplicate_publish_rejected");
    expect(ev.some((e) => e.camera_id === cam.id && e.source_ip === "198.51.100.8")).toBe(true);
    // Vídeo antigo (fora da janela) → publicação volta a ser aceita (reconexão após queda).
    await ownerQuery(
      db,
      `UPDATE cameras SET last_video_at = now() - interval '60 seconds'
      WHERE id = $1`,
      [cam.id],
    );
    expect((await auth(publish(path, "198.51.100.8"))).statusCode).toBe(200);
  });

  it("recusa segunda autorização enquanto a primeira ainda está conectando", async () => {
    const path = mediaPathForKey(keys["condominio-sol/CAM-001"]!);
    expect((await auth(publish(path, "203.0.113.20"))).statusCode).toBe(200);
    expect((await auth(publish(path, "203.0.113.21"))).statusCode).toBe(401);
  });

  it("recusa protocolo diferente de RTMP", async () => {
    const res = await auth(
      publish(mediaPathForKey(keys["empresa-alfa/CAM-004"]!), "203.0.113.1", "rtsp"),
    );
    expect(res.statusCode).toBe(401);
    expect(
      (await events("publish_denied")).some((e) => e.data.reason === "protocol_not_allowed"),
    ).toBe(true);
  });

  it("recusa câmera desabilitada e cliente suspenso", async () => {
    await ownerQuery(
      db,
      `UPDATE cameras SET enabled = false WHERE code = 'CAM-005'
                          AND tenant_id = (SELECT id FROM tenants WHERE slug = 'empresa-alfa')`,
    );
    expect((await auth(publish(mediaPathForKey(keys["empresa-alfa/CAM-005"]!)))).statusCode).toBe(
      401,
    );
    await ownerQuery(db, "UPDATE tenants SET status = 'suspended' WHERE slug = 'condominio-sol'");
    expect((await auth(publish(mediaPathForKey(keys["condominio-sol/CAM-001"]!)))).statusCode).toBe(
      401,
    );
    const reasons = (await events("publish_denied")).map((e) => e.data.reason);
    expect(reasons).toEqual(expect.arrayContaining(["camera_disabled", "tenant_inactive"]));
    await ownerQuery(db, "UPDATE tenants SET status = 'active' WHERE slug = 'condominio-sol'");
    await ownerQuery(db, "UPDATE cameras SET enabled = true WHERE code = 'CAM-005'");
  });

  it("leitura só com a credencial interna", async () => {
    const path = mediaPathForKey(keys["empresa-alfa/CAM-001"]!);
    const base = { ip: "172.20.0.5", action: "read", path, protocol: "rtsp", id: null, query: "" };
    expect((await auth({ ...base, user: "topcam-internal", password: READ_PASS })).statusCode).toBe(
      200,
    );
    expect((await auth({ ...base, user: "topcam-internal", password: "x" })).statusCode).toBe(401);
    expect((await auth({ ...base, user: "", password: "" })).statusCode).toBe(401);
    expect((await auth({ ...base, action: "api" })).statusCode).toBe(401);
  });
});

describe("hooks de estado", () => {
  it("online → recebendo + validação agendada; offline → offline", async () => {
    const path = mediaPathForKey(keys["empresa-alfa/CAM-001"]!);
    expect((await auth(publish(path))).statusCode).toBe(200);
    expect((await hook("online", path)).statusCode).toBe(204);
    let cam = await camera("CAM-001");
    expect(cam.status).toBe("recebendo");
    expect(cam.last_video_at).not.toBeNull();
    const jobs = await ownerQuery(
      db,
      "SELECT type, payload FROM durable_jobs WHERE type = 'camera.probe' AND status = 'pending'",
    );
    expect(jobs.some((j) => j.payload.cameraId === cam.id)).toBe(true);
    // Hook repetido não duplica a tarefa.
    await hook("online", path);
    const n = await ownerQuery(
      db,
      "SELECT count(*)::int AS n FROM durable_jobs WHERE dedup_key = $1 AND status = 'pending'",
      [`probe:${cam.id}`],
    );
    expect(n[0]!.n).toBe(1);

    expect((await hook("offline", path)).statusCode).toBe(204);
    cam = await camera("CAM-001");
    expect(cam.status).toBe("offline");
    expect((await events("stream_offline")).some((e) => e.camera_id === cam.id)).toBe(true);
  });

  it("nunca marca 'gravando' por hook", async () => {
    const rows = await ownerQuery(
      db,
      "SELECT count(*)::int AS n FROM cameras WHERE status = 'gravando'",
    );
    expect(rows[0]!.n).toBe(0);
  });

  it("ignora hook de caminho desconhecido e evento inválido", async () => {
    expect((await hook("online", mediaPathForKey(generateStreamKey()))).statusCode).toBe(204);
    expect((await hook("qualquer", "live/x")).statusCode).toBe(404);
  });
});
