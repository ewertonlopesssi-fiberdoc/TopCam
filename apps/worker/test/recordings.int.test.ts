import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPool, type JobRow, type Pool } from "@topcam/db";
import { type MediaMtxClient } from "@topcam/shared";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, ownerQuery, type TestDb } from "../../../packages/db/test/helpers.js";
import type { WorkerContext } from "../src/context.js";
import { loadEnv } from "../src/env.js";
import {
  applyRetention,
  checkRecordingHealth,
  scanRecordings,
  verifySegmentJob,
} from "../src/jobs/recordings.js";

/**
 * Gravação (Fase 4): conferência, varredura, retenção e saúde, com arquivos fMP4
 * reais gerados pelo ffmpeg (o mesmo formato que o MediaMTX grava).
 */

let db: TestDb;
let pool: Pool;
let ctx: WorkerContext;
let root: string;
let cam1: string; // Empresa Alfa CAM-001 (grava)
let cam2: string; // Empresa Alfa CAM-002 (só ao vivo)
let sample: string; // fMP4 de 2 s com vídeo e áudio

function fmp4(file: string, seconds: number, audio = true) {
  const args = [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=320x180:rate=15:duration=${seconds}`,
  ];
  if (audio) args.push("-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`);
  args.push("-c:v", "libx264", "-preset", "ultrafast", "-g", "15");
  if (audio) args.push("-c:a", "aac");
  args.push("-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "-y", file);
  execFileSync("ffmpeg", args);
}

const stamp = (d: Date) =>
  d
    .toISOString()
    .replace("T", "_")
    .replace(/:/g, "-")
    .replace(/\.(\d{3})Z$/, "-$1000");

/** Cria o arquivo do segmento no disco (cópia do exemplo) e devolve o caminho relativo. */
function placeSegment(cameraId: string, startedAt: Date, content?: Buffer | "sample"): string {
  const dir = join(root, "cam", cameraId);
  mkdirSync(dir, { recursive: true });
  const rel = `cam/${cameraId}/${stamp(startedAt)}.mp4`;
  if (content === "sample" || content === undefined) execFileSync("cp", [sample, join(root, rel)]);
  else writeFileSync(join(root, rel), content);
  return rel;
}

async function insertSegment(cameraId: string, rel: string, startedAt: Date, state = "writing") {
  const [row] = await ownerQuery<{ id: string }>(
    db,
    `INSERT INTO recording_segments (tenant_id, camera_id, storage_node_id, path, started_at, expires_at, state)
     SELECT c.tenant_id, c.id, (SELECT id FROM storage_nodes LIMIT 1), $2, $3, $3::timestamptz + interval '24 hours', $4
       FROM cameras c WHERE c.id = $1 RETURNING id`,
    [cameraId, rel, startedAt, state],
  );
  return row!.id;
}

const job = (segmentId: string): JobRow =>
  ({
    id: "1",
    type: "segment.verify",
    payload: { segmentId },
    attempts: 1,
    max_attempts: 5,
  }) as JobRow;

async function events(cameraId: string, type: string) {
  return ownerQuery<{ message: string; data: Record<string, unknown> }>(
    db,
    "SELECT message, data FROM camera_events WHERE camera_id = $1 AND type = $2 ORDER BY id",
    [cameraId, type],
  );
}

beforeAll(async () => {
  db = await createTestDb();
  pool = createPool(db.appUrl, 4);
  root = mkdtempSync(join(tmpdir(), "topcam-rec-"));
  sample = join(root, "sample.mp4");
  fmp4(sample, 2);
  ctx = {
    env: loadEnv({
      DATABASE_URL: db.appUrl,
      REDIS_URL: "redis://unused",
      MEDIA_READ_PASSWORD: randomBytes(16).toString("hex"),
      STREAM_KEY_ENC_KEY: db.encKeyB64,
      JWT_SECRET: randomBytes(32).toString("hex"),
      RECORDINGS_PATH: root,
      RECORDING_STALL_S: "120",
    }),
    pool,
    mediamtx: {} as MediaMtxClient,
    log: pino({ level: "silent" }),
    encKey: Buffer.alloc(32),
    runProbe: async () => ({}),
  };
  const rows = await ownerQuery<{ id: string; code: string }>(
    db,
    `SELECT c.id, c.code FROM cameras c JOIN tenants t ON t.id = c.tenant_id WHERE t.slug = 'empresa-alfa'`,
  );
  cam1 = rows.find((r) => r.code === "CAM-001")!.id;
  cam2 = rows.find((r) => r.code === "CAM-002")!.id;
});

afterAll(async () => {
  await pool?.end();
  await db?.drop();
  if (root) rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await ownerQuery(db, "DELETE FROM recording_segments");
  await ownerQuery(db, "DELETE FROM camera_events");
  await ownerQuery(db, "UPDATE cameras SET last_durable_segment_at = NULL");
  rmSync(join(root, "cam"), { recursive: true, force: true });
});

describe("conferência de segmentos", () => {
  it("segmento válido vira verified (tamanho, SHA-256, codecs, duração) e a câmera passa a gravando", async () => {
    await ownerQuery(db, "UPDATE cameras SET status = 'ao_vivo' WHERE id = $1", [cam1]);
    const start = new Date(Date.now() - 5000);
    const rel = placeSegment(cam1, start);
    const id = await insertSegment(cam1, rel, start);
    await verifySegmentJob(ctx, job(id));
    const [seg] = await ownerQuery<Record<string, unknown>>(
      db,
      "SELECT state, duration_ms, size_bytes, checksum_sha256, video_codec, audio_codec, ended_at FROM recording_segments WHERE id = $1",
      [id],
    );
    expect(seg).toMatchObject({ state: "verified", video_codec: "h264", audio_codec: "aac" });
    expect(Number(seg!.duration_ms)).toBeGreaterThan(1500);
    expect(Number(seg!.duration_ms)).toBeLessThan(2600);
    expect(String(seg!.checksum_sha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(Number(seg!.size_bytes)).toBeGreaterThan(1000);
    const [cam] = await ownerQuery<{ status: string; last_durable_segment_at: Date }>(
      db,
      "SELECT status, last_durable_segment_at FROM cameras WHERE id = $1",
      [cam1],
    );
    expect(cam!.status).toBe("gravando");
    expect(cam!.last_durable_segment_at).not.toBeNull();
    expect(await events(cam1, "recording_started")).toHaveLength(1);
  });

  it("arquivo sem vídeo legível vira corrupt; arquivo ausente vira missing (com eventos)", async () => {
    const t = new Date(Date.now() - 60_000);
    const bad = placeSegment(cam1, t, Buffer.from("isto não é um mp4"));
    const badId = await insertSegment(cam1, bad, t);
    await verifySegmentJob(ctx, job(badId));
    const t2 = new Date(Date.now() - 30_000);
    const goneId = await insertSegment(cam1, `cam/${cam1}/${stamp(t2)}.mp4`, t2);
    await verifySegmentJob(ctx, job(goneId));
    const states = await ownerQuery<{ id: string; state: string }>(
      db,
      "SELECT id::text, state FROM recording_segments ORDER BY id",
    );
    expect(states.map((s) => s.state)).toEqual(["corrupt", "missing"]);
    expect(await events(cam1, "segment_corrupt")).toHaveLength(1);
    expect(await events(cam1, "segment_missing")).toHaveLength(1);
  });

  it("registra a lacuna entre segmentos uma única vez", async () => {
    const a = new Date(Date.now() - 120_000);
    const b = new Date(a.getTime() + 2_000 + 20_000); // 2 s de vídeo + 20 s sem sinal
    const idA = await insertSegment(cam1, placeSegment(cam1, a), a);
    const idB = await insertSegment(cam1, placeSegment(cam1, b), b);
    await verifySegmentJob(ctx, job(idB)); // fora de ordem: o anterior ainda não tem fim
    await verifySegmentJob(ctx, job(idA));
    await verifySegmentJob(ctx, job(idA)); // repetido não duplica
    const gaps = await events(cam1, "recording_gap");
    expect(gaps).toHaveLength(1);
    expect(Number(gaps[0]!.data.gap_seconds)).toBeGreaterThan(18);
    expect(Number(gaps[0]!.data.gap_seconds)).toBeLessThan(22);
  });
});

describe("varredura da pasta", () => {
  it("indexa arquivos que os hooks não informaram e manda conferir os parados", async () => {
    const old = new Date(Date.now() - 300_000);
    const rel = placeSegment(cam1, old);
    utimesSync(join(root, rel), old, old); // arquivo parado há 5 min
    const fresh = new Date();
    placeSegment(cam1, fresh); // sendo escrito agora
    const r = await scanRecordings(ctx);
    expect(r).toMatchObject({ files: 2, indexed: 2, queued: 1, unexpected: 0 });
    const jobs = await ownerQuery(db, "SELECT 1 FROM durable_jobs WHERE type = 'segment.verify'");
    expect(jobs).toHaveLength(1);
    // Segunda passada: nada novo.
    expect((await scanRecordings(ctx)).indexed).toBe(0);
  });

  it("marca como missing o segmento conferido cujo arquivo sumiu", async () => {
    const t = new Date(Date.now() - 600_000);
    const rel = placeSegment(cam1, t);
    const id = await insertSegment(cam1, rel, t, "verified");
    rmSync(join(root, rel));
    const r = await scanRecordings(ctx);
    expect(r.missing).toBe(1);
    const [s] = await ownerQuery<{ state: string }>(
      db,
      "SELECT state FROM recording_segments WHERE id = $1",
      [id],
    );
    expect(s!.state).toBe("missing");
  });

  it("gravação encontrada numa câmera só ao vivo gera alerta", async () => {
    placeSegment(cam2, new Date(Date.now() - 200_000));
    const r = await scanRecordings(ctx);
    expect(r.unexpected).toBe(1);
    expect(await events(cam2, "unexpected_recording")).toHaveLength(1);
  });
});

describe("retenção", () => {
  it("apaga do disco e do índice só os vencidos", async () => {
    const t1 = new Date(Date.now() - 26 * 3600_000);
    const t2 = new Date(Date.now() - 3600_000);
    const expired = placeSegment(cam1, t1);
    const kept = placeSegment(cam1, t2);
    await insertSegment(cam1, expired, t1, "verified");
    await insertSegment(cam1, kept, t2, "verified");
    const r = await applyRetention(ctx);
    expect(r.deleted).toBe(1);
    expect(existsSync(join(root, expired))).toBe(false);
    expect(existsSync(join(root, kept))).toBe(true);
    const rows = await ownerQuery<{ path: string; state: string; deleted_at: Date | null }>(
      db,
      "SELECT path, state, deleted_at FROM recording_segments ORDER BY started_at",
    );
    expect(rows.map((x) => x.state)).toEqual(["deleted", "verified"]);
    expect(rows[0]!.deleted_at).not.toBeNull();
    expect((await applyRetention(ctx)).deleted).toBe(0);
  });

  it("nunca apaga fora da pasta de gravações", async () => {
    const t = new Date(Date.now() - 48 * 3600_000);
    await insertSegment(cam1, "../fora-da-raiz.mp4", t, "verified");
    writeFileSync(join(root, "..", "fora-da-raiz.mp4"), "x");
    await applyRetention(ctx);
    expect(existsSync(join(root, "..", "fora-da-raiz.mp4"))).toBe(true);
    rmSync(join(root, "..", "fora-da-raiz.mp4"));
    expect(readdirSync(root)).toContain("sample.mp4");
  });
});

describe("saúde da gravação", () => {
  it("gravando sem segmento recente volta a ao vivo com alerta (um por janela)", async () => {
    await ownerQuery(
      db,
      `UPDATE cameras SET status = 'gravando', status_changed_at = now() - interval '10 minutes',
              last_durable_segment_at = now() - interval '5 minutes' WHERE id = $1`,
      [cam1],
    );
    const r = await checkRecordingHealth(ctx);
    expect(r.stalled).toBe(1);
    const [c] = await ownerQuery<{ status: string }>(
      db,
      "SELECT status FROM cameras WHERE id = $1",
      [cam1],
    );
    expect(c!.status).toBe("ao_vivo");
    expect((await checkRecordingHealth(ctx)).stalled).toBe(0);
    expect(await events(cam1, "recording_stalled")).toHaveLength(1);
  });

  it("gravação desligada (geral) tira a câmera de gravando na hora; só ao vivo não alerta", async () => {
    await ownerQuery(
      db,
      "UPDATE cameras SET status = 'gravando', last_durable_segment_at = now() WHERE id = $1",
      [cam1],
    );
    await ownerQuery(
      db,
      "UPDATE cameras SET status = 'ao_vivo', status_changed_at = now() - interval '1 hour' WHERE id = $1",
      [cam2],
    );
    await ownerQuery(
      db,
      "UPDATE system_settings SET value = 'false' WHERE key = 'recording.globally_enabled'",
    );
    const r = await checkRecordingHealth(ctx);
    expect(r).toEqual({ stalled: 0, stopped: 1 });
    expect(await events(cam1, "recording_stopped")).toHaveLength(1);
    expect(await events(cam2, "recording_stalled")).toHaveLength(0);
    await ownerQuery(
      db,
      "UPDATE system_settings SET value = 'true' WHERE key = 'recording.globally_enabled'",
    );
  });
});
