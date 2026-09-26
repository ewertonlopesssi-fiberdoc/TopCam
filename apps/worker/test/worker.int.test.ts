import { randomBytes } from "node:crypto";
import { createPool, type JobRow, type Pool } from "@topcam/db";
import {
  decryptStreamKey,
  generateStreamKey,
  mediaPathForKey,
  parseEncryptionKey,
  type MediaMtxClient,
  type MtxPath,
  type MtxPathConf,
} from "@topcam/shared";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, ownerQuery, type TestDb } from "../../../packages/db/test/helpers.js";
import type { ProbeOutput, WorkerContext } from "../src/context.js";
import { loadEnv } from "../src/env.js";
import { probeJob } from "../src/jobs/probe.js";
import { reconcileMediaServer } from "../src/jobs/reconcile.js";
import { newPollerState, pollOnce } from "../src/poller.js";

/** MediaMTX falso em memória. */
class FakeMtx {
  paths = new Map<string, MtxPath>();
  confs = new Map<string, MtxPathConf>([["all_others", { name: "all_others" }]]);
  publishers: Array<{
    id: string;
    path: string;
    kind: "rtmpconns";
    state: string;
    remoteAddr: string;
  }> = [];
  kicked: string[] = [];
  down = false;
  private check() {
    if (this.down) throw new Error("MediaMTX inacessível");
  }
  async listPaths() {
    this.check();
    return [...this.paths.values()];
  }
  async getPath(n: string) {
    this.check();
    return this.paths.get(n) ?? null;
  }
  async listPathConfs() {
    this.check();
    return [...this.confs.values()];
  }
  async addPathConf(n: string, c: object) {
    this.confs.set(n, { name: n, ...c });
  }
  async patchPathConf(n: string, c: object) {
    this.confs.set(n, { ...this.confs.get(n)!, ...c });
  }
  async deletePathConf(n: string) {
    this.confs.delete(n);
  }
  async listPublishers() {
    this.check();
    return this.publishers.map((p) => ({ ...p, created: "", bytesReceived: 0 }));
  }
  async kick(_k: string, id: string) {
    this.kicked.push(id);
    this.publishers = this.publishers.filter((p) => p.id !== id);
  }
  live(path: string, bytes: number) {
    this.paths.set(path, {
      name: path,
      confName: path,
      ready: true,
      online: true,
      readyTime: new Date().toISOString(),
      source: { type: "rtmpConn", id: "s1" },
      tracks: ["H264"],
      bytesReceived: bytes,
    });
  }
}

let db: TestDb;
let pool: Pool;
let mtx: FakeMtx;
let probeResult: ProbeOutput | Error;
let ctx: WorkerContext;
let keys: Record<string, string>;

beforeAll(async () => {
  db = await createTestDb();
  pool = createPool(db.appUrl, 4);
  const env = loadEnv({
    DATABASE_URL: db.appUrl,
    REDIS_URL: "redis://unused",
    MEDIA_READ_PASSWORD: randomBytes(16).toString("hex"),
    STREAM_KEY_ENC_KEY: db.encKeyB64,
    OFFLINE_AFTER_S: "1",
    CONNECT_TIMEOUT_S: "1",
  });
  mtx = new FakeMtx();
  ctx = {
    env,
    pool,
    mediamtx: mtx as unknown as MediaMtxClient,
    log: pino({ level: "silent" }),
    encKey: parseEncryptionKey(db.encKeyB64),
    runProbe: async () => {
      if (probeResult instanceof Error) throw probeResult;
      return probeResult;
    },
  };
  const rows = await ownerQuery<{ slug: string; code: string; stream_key_enc: string }>(
    db,
    "SELECT t.slug, c.code, c.stream_key_enc FROM cameras c JOIN tenants t ON t.id = c.tenant_id",
  );
  keys = Object.fromEntries(
    rows.map((r) => [`${r.slug}/${r.code}`, decryptStreamKey(r.stream_key_enc, ctx.encKey)]),
  );
});

afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

async function cam(code: string, slug = "empresa-alfa") {
  return (
    await ownerQuery<Record<string, unknown> & { id: string; status: string }>(
      db,
      `SELECT c.* FROM cameras c JOIN tenants t ON t.id = c.tenant_id WHERE t.slug = $1 AND c.code = $2`,
      [slug, code],
    )
  )[0]!;
}
async function setStatus(code: string, status: string, extra = "", changedAt = "now()") {
  await ownerQuery(
    db,
    `UPDATE cameras SET status = $2, status_changed_at = ${changedAt} ${extra}
    WHERE code = $1 AND tenant_id = (SELECT id FROM tenants WHERE slug = 'empresa-alfa')`,
    [code, status],
  );
}
const job = (cameraId: string, attempts = 1): JobRow => ({
  id: "0",
  type: "camera.probe",
  payload: { cameraId },
  attempts,
  max_attempts: 3,
});

describe("validação (probe)", () => {
  beforeEach(() => mtx.paths.clear());

  it("H.264 válido → ao_vivo com codec, resolução e fps", async () => {
    await setStatus("CAM-002", "recebendo");
    probeResult = {
      streams: [
        {
          codec_type: "video",
          codec_name: "h264",
          width: 1280,
          height: 720,
          avg_frame_rate: "15/1",
        },
        { codec_type: "audio", codec_name: "aac" },
      ],
    };
    const c = await cam("CAM-002");
    await probeJob(ctx, job(c.id));
    const after = await cam("CAM-002");
    expect(after).toMatchObject({
      status: "ao_vivo",
      video_codec: "h264",
      audio_codec: "aac",
      width: 1280,
      height: 720,
    });
    expect(Number(after.fps)).toBe(15);
  });

  it("codec não suportado → erro com evento", async () => {
    await setStatus("CAM-003", "recebendo");
    probeResult = {
      streams: [{ codec_type: "video", codec_name: "mjpeg", width: 640, height: 480 }],
    };
    const c = await cam("CAM-003");
    await probeJob(ctx, job(c.id));
    expect((await cam("CAM-003")).status).toBe("erro");
    const ev = await ownerQuery(
      db,
      "SELECT data FROM camera_events WHERE camera_id = $1 AND type = 'probe_failed'",
      [c.id],
    );
    expect(ev[0]!.data.reason).toBe("codec_unsupported");
  });

  it("H.265 → ao_vivo com aviso de compatibilidade", async () => {
    await setStatus("CAM-004", "recebendo");
    probeResult = {
      streams: [
        {
          codec_type: "video",
          codec_name: "hevc",
          width: 1920,
          height: 1080,
          avg_frame_rate: "25/1",
        },
      ],
    };
    const c = await cam("CAM-004");
    await probeJob(ctx, job(c.id));
    expect((await cam("CAM-004")).status).toBe("ao_vivo");
    const ev = await ownerQuery(
      db,
      "SELECT count(*)::int AS n FROM camera_events WHERE camera_id = $1 AND type = 'codec_warning'",
      [c.id],
    );
    expect(ev[0]!.n).toBe(1);
  });

  it("falha do ffprobe com stream ativo: repete e, na última tentativa, marca erro", async () => {
    await setStatus("CAM-005", "recebendo");
    const c = await cam("CAM-005");
    mtx.live(mediaPathForKey(keys["empresa-alfa/CAM-005"]!), 100);
    probeResult = new Error(`timeout em rtsp://u:p@mediamtx/live/${keys["empresa-alfa/CAM-005"]}`);
    await expect(probeJob(ctx, job(c.id, 1))).rejects.toThrow(/timeout/);
    await probeJob(ctx, job(c.id, 3));
    expect((await cam("CAM-005")).status).toBe("erro");
    const ev = await ownerQuery(
      db,
      "SELECT message FROM camera_events WHERE camera_id = $1 AND type = 'probe_failed'",
      [c.id],
    );
    expect(ev[0]!.message).not.toContain(keys["empresa-alfa/CAM-005"]);
  });
});

describe("reconciliação do servidor de mídia", () => {
  it("cria entrada live/<chave> e relay cam/<id> por câmera, sem gravação na Fase 1", async () => {
    const r = await reconcileMediaServer(ctx);
    expect(r.added).toBe(12);
    expect(r.recording).toBe(0);
    const live = [...mtx.confs.values()].filter((c) => c.name.startsWith("live/"));
    const cams = [...mtx.confs.values()].filter((c) => c.name.startsWith("cam/"));
    expect(live).toHaveLength(6);
    expect(cams).toHaveLength(6);
    expect(live.every((c) => c.record === false && c.overridePublisher === false)).toBe(true);
    expect(cams.every((c) => c.record === false && c.sourceOnDemand === true)).toBe(true);
    const cam1 = await cam("CAM-001");
    const relay = mtx.confs.get(`cam/${cam1.id}`)!;
    expect(relay.source).toContain(`@127.0.0.1:8554/live/${keys["empresa-alfa/CAM-001"]}`);
    expect(relay.name).not.toContain(keys["empresa-alfa/CAM-001"]);
  });

  it("liga gravação apenas no relay da CAM-001 quando a gravação global é habilitada", async () => {
    await ownerQuery(
      db,
      "UPDATE system_settings SET value = 'true' WHERE key = 'recording.globally_enabled'",
    );
    const r = await reconcileMediaServer(ctx);
    expect(r.recording).toBe(1);
    const cam1 = await cam("CAM-001");
    const recording = [...mtx.confs.values()].filter((c) => c.record === true);
    expect(recording.map((c) => c.name)).toEqual([`cam/${cam1.id}`]);
    expect(recording[0]!.sourceOnDemand).toBe(false);
    await ownerQuery(
      db,
      "UPDATE system_settings SET value = 'false' WHERE key = 'recording.globally_enabled'",
    );
    await reconcileMediaServer(ctx);
    expect([...mtx.confs.values()].some((c) => c.record === true)).toBe(false);
  });

  it("remove caminho de chave antiga e desconecta quem ainda a usa", async () => {
    const stale = mediaPathForKey(generateStreamKey());
    mtx.confs.set(stale, { name: stale, record: false });
    mtx.publishers.push({
      id: "p-old",
      path: stale,
      kind: "rtmpconns",
      state: "publish",
      remoteAddr: "198.51.100.3:5000",
    });
    const valid = mediaPathForKey(keys["empresa-alfa/CAM-002"]!);
    mtx.publishers.push({
      id: "p-ok",
      path: valid,
      kind: "rtmpconns",
      state: "publish",
      remoteAddr: "198.51.100.4:5000",
    });
    const r = await reconcileMediaServer(ctx);
    expect(r.removed).toBe(1);
    expect(mtx.kicked).toEqual(["p-old"]);
    expect(mtx.confs.has(stale)).toBe(false);
    const ev = await ownerQuery(
      db,
      "SELECT host(source_ip) AS ip FROM camera_events WHERE type = 'publisher_kicked'",
    );
    expect(ev[0]!.ip).toBe("198.51.100.3");
  });
});

describe("poller de status", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("recupera câmera transmitindo, detecta vídeo parado e queda", async () => {
    mtx.paths.clear();
    const path = mediaPathForKey(keys["empresa-alfa/CAM-002"]!);
    await setStatus("CAM-002", "offline");
    const state = newPollerState();

    mtx.live(path, 1000);
    await pollOnce(ctx, state);
    let c = await cam("CAM-002");
    expect(c.status).toBe("recebendo");
    expect(c.last_video_at).not.toBeNull();

    await setStatus("CAM-002", "ao_vivo");
    mtx.live(path, 5000);
    await sleep(50);
    await pollOnce(ctx, state);
    expect((await cam("CAM-002")).bitrate_kbps).not.toBeNull();

    // Bytes parados por mais que OFFLINE_AFTER_S (1 s) → offline por vídeo parado.
    await sleep(1200);
    await pollOnce(ctx, state);
    c = await cam("CAM-002");
    expect(c.status).toBe("offline");
    const ev = await ownerQuery(
      db,
      "SELECT data FROM camera_events WHERE camera_id = $1 AND type = 'stream_offline' ORDER BY id DESC LIMIT 1",
      [c.id],
    );
    expect(ev[0]!.data.reason).toBe("video_stalled");
  });

  it("stream some → offline; conectando sem vídeo → timeout", async () => {
    mtx.paths.clear();
    await setStatus("CAM-003", "ao_vivo", ", last_video_at = now() - interval '5 seconds'");
    await setStatus(
      "CAM-004",
      "conectando",
      ", last_video_at = NULL",
      "now() - interval '5 seconds'",
    );
    await pollOnce(ctx, newPollerState());
    expect((await cam("CAM-003")).status).toBe("offline");
    expect((await cam("CAM-004")).status).toBe("aguardando_transmissao");
  });

  it("caminho sem publicador → offline imediato, mesmo com vídeo recente", async () => {
    mtx.paths.clear();
    mtx.down = false;
    await setStatus("CAM-005", "ao_vivo", ", last_video_at = now()");
    await pollOnce(ctx, newPollerState());
    const c = await cam("CAM-005");
    expect(c.status).toBe("offline");
    const ev = await ownerQuery(
      db,
      "SELECT data FROM camera_events WHERE camera_id = $1 AND type = 'stream_offline' ORDER BY id DESC LIMIT 1",
      [c.id],
    );
    expect(ev[0]!.data.reason).toBe("stream_gone");
  });

  it("MediaMTX inacessível não derruba câmera com vídeo recente antes do prazo", async () => {
    mtx.down = true;
    await setStatus("CAM-002", "ao_vivo", ", last_video_at = now()");
    await pollOnce(ctx, newPollerState());
    expect((await cam("CAM-002")).status).toBe("ao_vivo");
    mtx.down = false;
  });

  it("registra servidor de mídia inacessível e a recuperação", async () => {
    const state = newPollerState();
    await pollOnce(ctx, state);
    mtx.down = true;
    const r1 = await pollOnce(ctx, state);
    expect(r1.reachable).toBe(false);
    let alerts = await ownerQuery(
      db,
      "SELECT status FROM alerts WHERE rule = 'ingest_unreachable'",
    );
    expect(alerts.map((a) => a.status)).toEqual(["open"]);
    mtx.down = false;
    const r2 = await pollOnce(ctx, state);
    expect(r2.recovered).toBe(true);
    alerts = await ownerQuery(db, "SELECT status FROM alerts WHERE rule = 'ingest_unreachable'");
    expect(alerts.map((a) => a.status)).toEqual(["resolved"]);
  });
});
