import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPool, type Pool } from "@topcam/db";
import { type MediaMtxClient } from "@topcam/shared";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, ownerQuery, type TestDb } from "../../../packages/db/test/helpers.js";
import type { WorkerContext } from "../src/context.js";
import { loadEnv } from "../src/env.js";
import { collectHostMetrics, newHostState, parsePressure } from "../src/jobs/host.js";
import { verifySegmentJob } from "../src/jobs/recordings.js";
import { checkStorage, levelOf, newStorageState, usage, type FsInfo } from "../src/jobs/storage.js";
import { findHoles, probeFile } from "../src/lib/ffprobe.js";

/**
 * Armazenamento (Fase 6): níveis 70/85/95%, limpeza de emergência (mais antigo
 * primeiro, respeitando a idade mínima), bloqueio como proteção final e retomada,
 * disco lento, cota por cliente, métricas do servidor e buracos em segmentos.
 * O "disco" é simulado (measure injetado); os arquivos e o banco são reais.
 */

const GB = 1024 ** 3;
let db: TestDb;
let pool: Pool;
let ctx: WorkerContext;
let root: string;
let cam1: string;
let tenant: string;
let node: string;

let disk: FsInfo = { total: 100 * GB, free: 50 * GB };
let latency = 5;
const deps = {
  measure: async () => disk,
  latency: async () => latency,
};

const stamp = (d: Date) =>
  d
    .toISOString()
    .replace("T", "_")
    .replace(/:/g, "-")
    .replace(/\.(\d{3})Z$/, "-$1000");

/** Segmento conferido de `sizeGb` GB (arquivo pequeno no disco; o tamanho vem do índice). */
async function seg(minutesAgo: number, sizeGb: number) {
  const started = new Date(Date.now() - minutesAgo * 60_000);
  const rel = `cam/${cam1}/${stamp(started)}.mp4`;
  mkdirSync(join(root, "cam", cam1), { recursive: true });
  writeFileSync(join(root, rel), "x");
  await ownerQuery(
    db,
    `INSERT INTO recording_segments (tenant_id, camera_id, storage_node_id, path, started_at, ended_at,
                                     duration_ms, size_bytes, state, expires_at)
     VALUES ($1, $2, $3, $4, $5, $5::timestamptz + interval '60 s', 60000, $6, 'verified', now() + interval '1 day')`,
    [tenant, cam1, node, rel, started, Math.round(sizeGb * GB)],
  );
  return rel;
}

const nodeRow = async () =>
  (
    await ownerQuery<{
      status: string;
      recording_blocked: boolean;
      used_pct: string;
      write_latency_ms: number;
    }>(
      db,
      "SELECT status, recording_blocked, used_pct::text, write_latency_ms FROM storage_nodes WHERE id = $1",
      [node],
    )
  )[0]!;
const openAlerts = async () =>
  (
    await ownerQuery<{ rule: string; severity: string }>(
      db,
      "SELECT rule, severity FROM alerts WHERE status <> 'resolved' ORDER BY rule",
    )
  ).map((a) => `${a.rule}:${a.severity}`);
const events = async (type: string) =>
  ownerQuery<{ data: Record<string, unknown>; message: string }>(
    db,
    "SELECT data, message FROM camera_events WHERE type = $1 ORDER BY id",
    [type],
  );
const setSetting = (key: string, value: unknown) =>
  ownerQuery(db, "UPDATE system_settings SET value = $2 WHERE key = $1", [
    key,
    JSON.stringify(value),
  ]);

beforeAll(async () => {
  db = await createTestDb();
  pool = createPool(db.appUrl, 4);
  root = mkdtempSync(join(tmpdir(), "topcam-sto-"));
  ctx = {
    env: loadEnv({
      DATABASE_URL: db.appUrl,
      REDIS_URL: "redis://unused",
      MEDIA_READ_PASSWORD: randomBytes(16).toString("hex"),
      STREAM_KEY_ENC_KEY: db.encKeyB64,
      JWT_SECRET: randomBytes(32).toString("hex"),
      RECORDINGS_PATH: root,
      STORAGE_SLOW_MS: "1000",
    }),
    pool,
    mediamtx: {} as MediaMtxClient,
    log: pino({ level: "silent" }),
    encKey: Buffer.alloc(32),
    runProbe: async () => ({}),
  };
  const [r] = await ownerQuery<{ id: string; tenant_id: string; storage_node_id: string }>(
    db,
    `SELECT c.id, c.tenant_id, c.storage_node_id FROM cameras c JOIN tenants t ON t.id = c.tenant_id
      WHERE t.slug = 'empresa-alfa' AND c.code = 'CAM-001'`,
  );
  cam1 = r!.id;
  tenant = r!.tenant_id;
  node = r!.storage_node_id;
});

afterAll(async () => {
  await pool?.end();
  await db?.drop();
  if (root) rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await ownerQuery(db, "DELETE FROM recording_segments");
  await ownerQuery(db, "DELETE FROM camera_events");
  await ownerQuery(db, "DELETE FROM alerts");
  await ownerQuery(db, "DELETE FROM durable_jobs");
  await ownerQuery(db, "DELETE FROM storage_samples");
  await ownerQuery(
    db,
    "UPDATE storage_nodes SET status = 'ok', recording_blocked = false, quota_bytes = NULL",
  );
  await ownerQuery(db, "UPDATE tenants SET storage_quota_bytes = NULL");
  await setSetting("storage.emergency_purge", true);
  await setSetting("storage.purge_min_age_minutes", 60);
  disk = { total: 100 * GB, free: 50 * GB };
  latency = 5;
});

describe("cálculo", () => {
  it("nível e bytes a liberar (disco e cota; vale o maior)", () => {
    const n = { warn_pct: 70, high_pct: 85, critical_pct: 95 };
    expect([69, 70, 85, 95].map((p) => levelOf(p, n))).toEqual([
      "ok",
      "warning",
      "high",
      "critical",
    ]);
    const u = usage({ total: 100, free: 4 }, 10, null, 90);
    expect(u.pct).toBe(96);
    expect(u.needBytes).toBe(6);
    const q = usage({ total: 100, free: 90 }, 48, 50, 90);
    expect(q.pct).toBe(96);
    expect(q.needBytes).toBe(3);
    // Com cota, o disco físico cheio abaixo do crítico não conta (a cota manda)…
    expect(usage({ total: 100, free: 10 }, 10, 50, 90).pct).toBe(20);
    // …mas no crítico o disco volta a valer (proteção).
    const f = usage({ total: 100, free: 3 }, 10, 50, 90);
    expect(f.pct).toBe(97);
    expect(f.needBytes).toBe(7);
  });
});

describe("vigia de disco", () => {
  it("toda câmera tem nó de armazenamento (migration + gatilho)", async () => {
    const r = await ownerQuery<{ n: number }>(
      db,
      "SELECT count(*)::int AS n FROM cameras WHERE storage_node_id IS NULL",
    );
    expect(r[0]!.n).toBe(0);
  });

  it("70% atenção, 85% alto: evento na mudança e um alerta só, atualizado", async () => {
    disk = { total: 100 * GB, free: 28 * GB };
    await checkStorage(ctx, newStorageState(), deps);
    expect((await nodeRow()).status).toBe("warning");
    expect(await openAlerts()).toEqual(["storage_level:warning"]);
    disk = { total: 100 * GB, free: 12 * GB };
    await checkStorage(ctx, newStorageState(), deps);
    expect((await nodeRow()).status).toBe("high");
    expect(await openAlerts()).toEqual(["storage_level:error"]);
    expect((await events("storage_level")).map((e) => e.data.to)).toEqual(["warning", "high"]);
    disk = { total: 100 * GB, free: 60 * GB };
    await checkStorage(ctx, newStorageState(), deps);
    expect((await nodeRow()).status).toBe("ok");
    expect(await openAlerts()).toEqual([]);
  });

  it("95%: apaga o mais antigo primeiro, até ~90%, protegendo a última hora", async () => {
    const old1 = await seg(300, 2);
    const old2 = await seg(240, 2);
    const old3 = await seg(180, 2);
    const recent = await seg(30, 2); // dentro da idade mínima: intocável
    disk = { total: 100 * GB, free: 4 * GB }; // 96%
    // Depois da limpeza, o disco "mede" o espaço liberado.
    let calls = 0;
    const r = await checkStorage(ctx, newStorageState(), {
      ...deps,
      measure: async () => (calls++ === 0 ? disk : { total: 100 * GB, free: 10 * GB }),
    });
    expect(r.purgedSegments).toBe(3); // 6 GB para ir de 96% a 90%
    expect(existsSync(join(root, old1))).toBe(false);
    expect(existsSync(join(root, old2))).toBe(false);
    expect(existsSync(join(root, old3))).toBe(false);
    expect(existsSync(join(root, recent))).toBe(true);
    const st = await ownerQuery<{ state: string }>(
      db,
      "SELECT state FROM recording_segments ORDER BY started_at",
    );
    expect(st.map((s) => s.state)).toEqual(["deleted", "deleted", "deleted", "verified"]);
    const [ev] = await events("storage_purge");
    expect(ev!.data).toMatchObject({ segments: 3, cameras: { "CAM-001": 3 }, min_age_minutes: 60 });
    const audit = await ownerQuery(
      db,
      "SELECT 1 FROM audit_logs WHERE action = 'storage.emergency_purge'",
    );
    expect(audit).toHaveLength(1);
    const n = await nodeRow();
    expect(n.recording_blocked).toBe(false);
    expect(n.status).toBe("high");
    expect(await openAlerts()).toEqual(["storage_level:error", "storage_purge:warning"]);
    // O aviso de gravação apagada antes do prazo fica aberto até o disco voltar ao normal.
    disk = { total: 100 * GB, free: 25 * GB };
    await checkStorage(ctx, newStorageState(), deps);
    expect(await openAlerts()).toEqual(["storage_level:warning", "storage_purge:warning"]);
    disk = { total: 100 * GB, free: 50 * GB };
    await checkStorage(ctx, newStorageState(), deps);
    expect(await openAlerts()).toEqual([]);
  });

  it("nada apagável (tudo recente): gravação para, com reconciliação; volta com espaço", async () => {
    const recent = await seg(10, 2);
    disk = { total: 100 * GB, free: 3 * GB };
    const r = await checkStorage(ctx, newStorageState(), deps);
    expect(r.purgedSegments).toBe(0);
    expect(r.blocked).toHaveLength(1);
    expect(existsSync(join(root, recent))).toBe(true);
    expect((await nodeRow()).recording_blocked).toBe(true);
    expect(await openAlerts()).toContain("storage_blocked:critical");
    const jobs = await ownerQuery<{ payload: { reason: string } }>(
      db,
      "SELECT payload FROM durable_jobs WHERE type = 'mediamtx.reconcile'",
    );
    expect(jobs.map((j) => j.payload.reason)).toEqual(["storage_blocked"]);
    // A câmera deixa de gravar na reconciliação (storage_blocked vem da junção com o nó).
    const [cam] = await ownerQuery<{ blocked: boolean }>(
      db,
      "SELECT s.recording_blocked AS blocked FROM cameras c JOIN storage_nodes s ON s.id = c.storage_node_id WHERE c.id = $1",
      [cam1],
    );
    expect(cam!.blocked).toBe(true);

    disk = { total: 100 * GB, free: 7 * GB }; // 93%: ainda acima de crítico − 5
    await checkStorage(ctx, newStorageState(), deps);
    expect((await nodeRow()).recording_blocked).toBe(true);
    disk = { total: 100 * GB, free: 20 * GB }; // 80%
    await checkStorage(ctx, newStorageState(), deps);
    expect((await nodeRow()).recording_blocked).toBe(false);
    expect(await openAlerts()).toEqual(["storage_level:warning"]);
    expect((await events("storage_recording_resumed")).length).toBe(1);
  });

  it("limpeza desligada: a 95% para a gravação direto, sem apagar", async () => {
    await setSetting("storage.emergency_purge", false);
    const old = await seg(300, 5);
    disk = { total: 100 * GB, free: 4 * GB };
    await checkStorage(ctx, newStorageState(), deps);
    expect(existsSync(join(root, old))).toBe(true);
    expect((await nodeRow()).recording_blocked).toBe(true);
  });

  it("cota do nó: vale o volume gravado mesmo com o disco folgado", async () => {
    await seg(300, 1);
    await seg(200, 1);
    await seg(100, 1);
    await ownerQuery(db, "UPDATE storage_nodes SET quota_bytes = $1", [Math.round(3.1 * GB)]);
    await checkStorage(ctx, newStorageState(), deps); // 3/3,1 = 96,8%
    const rows = await ownerQuery<{ state: string }>(
      db,
      "SELECT state FROM recording_segments ORDER BY started_at",
    );
    expect(rows.map((s) => s.state)).toEqual(["deleted", "verified", "verified"]);
    expect(Number((await nodeRow()).used_pct)).toBeLessThan(90);
  });

  it("disco lento: alerta acima de 1 s, resolvido após ~5 min estável", async () => {
    const state = newStorageState();
    latency = 2500;
    await checkStorage(ctx, state, deps);
    expect(await openAlerts()).toEqual(["storage_slow:warning"]);
    expect((await nodeRow()).write_latency_ms).toBe(2500);
    expect((await events("storage_slow"))[0]!.message).toContain("2,5 s");
    latency = 3;
    for (let i = 0; i < 9; i++) await checkStorage(ctx, state, deps);
    expect(await openAlerts()).toEqual(["storage_slow:warning"]);
    await checkStorage(ctx, state, deps);
    expect(await openAlerts()).toEqual([]);
  });

  it("cota do cliente: só alerta (90% atenção, 100% erro), nada é apagado", async () => {
    await seg(300, 1);
    await ownerQuery(db, "UPDATE tenants SET storage_quota_bytes = $2 WHERE id = $1", [tenant, GB]);
    await checkStorage(ctx, newStorageState(), deps);
    expect(await openAlerts()).toEqual(["tenant_quota:error"]);
    const [a] = await ownerQuery<{ tenant_id: string }>(db, "SELECT tenant_id FROM alerts");
    expect(a!.tenant_id).toBe(tenant);
    expect(
      (await ownerQuery<{ state: string }>(db, "SELECT state FROM recording_segments"))[0]!.state,
    ).toBe("verified");
    await ownerQuery(db, "UPDATE tenants SET storage_quota_bytes = $2 WHERE id = $1", [
      tenant,
      10 * GB,
    ]);
    await checkStorage(ctx, newStorageState(), deps);
    expect(await openAlerts()).toEqual([]);
  });

  it("amostras para gráficos a cada intervalo", async () => {
    const state = newStorageState();
    await checkStorage(ctx, state, deps);
    await checkStorage(ctx, state, deps); // dentro do intervalo: sem nova amostra
    const n = await ownerQuery(db, "SELECT 1 FROM storage_samples");
    expect(n).toHaveLength(1);
  });
});

describe("métricas do servidor", () => {
  it("lê CPU, memória, pressão de IO, disco do sistema e serviços; alerta disco do sistema", async () => {
    const files: Record<string, string> = {
      "/proc/stat":
        "cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0 0 0\ncpu1 50 0 50 400 0 0 0 0 0 0\n",
      "/proc/loadavg": "0.50 0.40 0.30 1/200 999",
      "/proc/meminfo": "MemTotal:        8000000 kB\nMemAvailable:    6000000 kB\n",
      "/proc/uptime": "3600.5 7000.0",
      "/proc/pressure/io":
        "some avg10=1.12 avg60=2.13 avg300=10.14 total=1\nfull avg10=1.10 avg60=2.07 avg300=9.78 total=1",
      "/proc/pressure/cpu": "some avg10=0.01 avg60=0.06 avg300=0.06 total=1",
    };
    const state = newHostState();
    const m = await collectHostMetrics(ctx, state, {
      read: async (p) => files[p]!,
      measure: async () => ({ total: 100 * GB, free: 10 * GB }),
      fetchReady: async () => ({ checks: { database: "ok", redis: "ok", mediamtx: "fail" } }),
    });
    expect(m).toMatchObject({
      cpus: 2,
      load1: 0.5,
      mem_total: 8000000 * 1024,
      io_pressure: { full300: 9.78 },
      system_disk: { pct: 90 },
      services: { worker: "ok", api: "ok", database: "ok", mediamtx: "fail" },
    });
    expect(await openAlerts()).toEqual(["system_disk:error"]);
    const [row] = await ownerQuery<{ metrics: { host: { system_disk: { pct: number } } } }>(
      db,
      "SELECT metrics FROM ingest_nodes WHERE name = 'ingest-01'",
    );
    expect(row!.metrics.host.system_disk.pct).toBe(90);
    expect(parsePressure("some avg10=1.5 avg60=0 avg300=0 total=0").some!.avg10).toBe(1.5);
  });
});

describe("buracos dentro de segmentos", () => {
  it("findHoles: saltos maiores que 3 s entre quadros", () => {
    expect(findHoles([0, 0.1, 0.2, 5.2, 5.3, 9.0])).toEqual([
      { from: 0.2, to: 5.2 },
      { from: 5.3, to: 9 },
    ]);
    expect(findHoles([0, 1, 2, 3])).toEqual([]);
  });

  it("conferência de arquivo real com 4 s sem vídeo: lacuna na linha do tempo e evento", async () => {
    const started = new Date(Date.now() - 5 * 60_000);
    const rel = `cam/${cam1}/${stamp(started)}.mp4`;
    mkdirSync(join(root, "cam", cam1), { recursive: true });
    // 10 s de vídeo com os quadros de 2 s a 6 s removidos (como um descarte do gravador).
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x90:rate=15:duration=10",
      "-vf",
      "select='not(between(t,2,6))'",
      "-fps_mode",
      "passthrough",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-g",
      "15",
      "-movflags",
      "frag_keyframe+empty_moov+default_base_moof",
      "-f",
      "mp4",
      "-y",
      join(root, rel),
    ]);
    const probe = await probeFile(join(root, rel));
    expect(probe.holes).toHaveLength(1);
    expect(probe.holes![0]!.to - probe.holes![0]!.from).toBeGreaterThan(3.9);
    const [row] = await ownerQuery<{ id: string }>(
      db,
      `INSERT INTO recording_segments (tenant_id, camera_id, storage_node_id, path, started_at, ended_at, duration_ms, state, expires_at)
       VALUES ($1, $2, $3, $4, $5, $5::timestamptz + interval '10 s', 10000, 'writing', now() + interval '1 day') RETURNING id`,
      [tenant, cam1, node, rel, started],
    );
    await verifySegmentJob(ctx, {
      id: "1",
      type: "segment.verify",
      payload: { segmentId: row!.id },
      attempts: 1,
      max_attempts: 5,
    } as never);
    const [s] = await ownerQuery<{ state: string; holes: Array<{ from: number; to: number }> }>(
      db,
      "SELECT state, holes FROM recording_segments WHERE id = $1",
      [row!.id],
    );
    expect(s!.state).toBe("verified");
    expect(s!.holes).toHaveLength(1);
    const ev = (await events("recording_gap")).filter((e) => e.data.kind === "internal");
    expect(ev).toHaveLength(1);
    expect(Number(ev[0]!.data.gap_seconds)).toBeGreaterThan(3.9);
  });
});
