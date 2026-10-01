import {
  PLATFORM,
  claimJob,
  completeJob,
  createPool,
  failJob,
  pruneDeletedSegments,
  pruneJobs,
  recoverStaleJobs,
  withScope,
  type JobRow,
} from "@topcam/db";
import { JOBS_WAKE_CHANNEL, MediaMtxClient, type JobType } from "@topcam/shared";
import { writeFile } from "node:fs/promises";
import { Redis } from "ioredis";
import { pino } from "pino";
import { makeEncKey, redact, type WorkerContext } from "./context.js";
import { loadEnv } from "./env.js";
import { probeJob } from "./jobs/probe.js";
import {
  applyRetention,
  checkRecordingHealth,
  scanRecordings,
  verifySegmentJob,
} from "./jobs/recordings.js";
import { collectHostMetrics, newHostState } from "./jobs/host.js";
import {
  accumulateHourly,
  checkCameraAlerts,
  newMonitorState,
  notifyAlerts,
  sampleStatus,
} from "./jobs/monitor.js";
import { keepMotion, processAlarms } from "./jobs/motion.js";
import { reconcileMediaServer } from "./jobs/reconcile.js";
import { checkStorage, newStorageState } from "./jobs/storage.js";
import { runFfprobe } from "./lib/ffprobe.js";
import { guardLiveSessions } from "./live-guard.js";
import { newPollerState, pollOnce } from "./poller.js";

const env = loadEnv();
const log = pino({ level: env.LOG_LEVEL, base: { svc: "worker", id: env.WORKER_ID } });
const pool = createPool(env.DATABASE_URL, 5);
const ctx: WorkerContext = {
  env,
  pool,
  mediamtx: new MediaMtxClient(env.MEDIAMTX_API_URL),
  log,
  encKey: makeEncKey(env),
  runProbe: runFfprobe,
};

const handlers: Record<JobType, (job: JobRow) => Promise<void>> = {
  "camera.probe": (job) => probeJob(ctx, job),
  "mediamtx.reconcile": async () => {
    await reconcileMediaServer(ctx);
  },
  "segment.verify": (job) => verifySegmentJob(ctx, job),
};

let stopping = false;
const wakers = new Set<() => void>();
const wakeAll = () => {
  for (const w of [...wakers]) w();
};

// ------------------------------------------------------------------ Redis: acordar o worker
const sub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
sub.on("error", (err) => log.warn({ err: err.message }, "redis"));
sub.subscribe(JOBS_WAKE_CHANNEL).catch((err) => log.warn({ err: err.message }, "subscribe falhou"));
sub.on("message", () => wakeAll());

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      wakers.delete(done);
      resolve();
    };
    const t = setTimeout(done, ms);
    wakers.add(done);
  });
}

// ------------------------------------------------------------------ fila de tarefas duráveis
async function jobLoop(): Promise<void> {
  while (!stopping) {
    let job: JobRow | null;
    try {
      job = await withScope(pool, PLATFORM, (c) => claimJob(c, env.WORKER_ID));
    } catch (err) {
      log.error({ err: (err as Error).message }, "falha ao buscar tarefa");
      await sleep(2000);
      continue;
    }
    if (!job) {
      await sleep(2000);
      continue;
    }
    const current = job;
    const started = Date.now();
    try {
      const handler = handlers[current.type];
      if (!handler) throw new Error(`tipo de tarefa desconhecido: ${current.type}`);
      await handler(current);
      await withScope(pool, PLATFORM, (c) => completeJob(c, current.id));
      log.debug(
        { job: current.id, type: current.type, ms: Date.now() - started },
        "tarefa concluída",
      );
    } catch (err) {
      const message = redact((err as Error).message);
      log.warn(
        { job: current.id, type: current.type, attempt: current.attempts, err: message },
        "tarefa falhou",
      );
      await withScope(pool, PLATFORM, (c) => failJob(c, current, message)).catch(() => undefined);
    }
  }
}

// ------------------------------------------------------------------ laços periódicos
function every(seconds: number, name: string, fn: () => Promise<unknown>): void {
  const run = async () => {
    if (stopping) return;
    try {
      await fn();
    } catch (err) {
      log.error({ task: name, err: redact((err as Error).message) }, "tarefa periódica falhou");
    }
    if (!stopping) setTimeout(run, seconds * 1000);
  };
  void run();
}

const pollerState = newPollerState();
let lastReconcile = 0;

async function reconcileNow(reason: string) {
  lastReconcile = Date.now();
  const report = await reconcileMediaServer(ctx);
  log.debug({ reason, ...report }, "reconciliação");
}

every(env.POLL_INTERVAL_S, "poller", async () => {
  const res = await pollOnce(ctx, pollerState);
  // Heartbeat para o healthcheck do contêiner.
  await writeFile("/tmp/worker-heartbeat", String(Date.now())).catch(() => undefined);
  if (res.reachable && (res.recovered || res.missingPathConfs)) {
    await reconcileNow(res.recovered ? "mediamtx_recovered" : "missing_path_confs");
  } else if (res.reachable && Date.now() - lastReconcile > env.RECONCILE_INTERVAL_S * 1000) {
    await reconcileNow("periodic");
  }
});

every(env.LIVE_GUARD_INTERVAL_S, "live-guard", async () => {
  await guardLiveSessions(ctx);
});

// Gravação: varredura da pasta (segmentos que os hooks não informaram) e retenção.
every(env.RECORDING_SCAN_INTERVAL_S, "recording-scan", async () => {
  const r = await scanRecordings(ctx);
  if (r.indexed || r.missing || r.unexpected) log.info(r, "varredura de gravações");
  if (r.queued) wakeAll();
  const h = await checkRecordingHealth(ctx);
  if (h.stalled || h.stopped) log.warn(h, "saúde da gravação");
});
every(env.RETENTION_INTERVAL_S, "retention", () => applyRetention(ctx));

// Armazenamento (Fase 6): limites 70/85/95%, limpeza de emergência, latência, cotas.
const storageState = newStorageState();
every(env.STORAGE_CHECK_INTERVAL_S, "storage", async () => {
  const r = await checkStorage(ctx, storageState);
  if (r.purgedSegments || r.blocked.length) {
    log.warn(r, "armazenamento");
    wakeAll();
  }
});
const hostState = newHostState();
every(env.HOST_METRICS_INTERVAL_S, "host-metrics", () => collectHostMetrics(ctx, hostState));

// Monitoramento (Fase 7): alertas de câmera, disponibilidade, amostras e e-mail.
const monitorState = newMonitorState();
every(env.CAMERA_ALERTS_INTERVAL_S, "camera-alerts", async () => {
  const r = await checkCameraAlerts(ctx);
  if (r.opened || r.resolved) log.info(r, "alertas de câmera");
});
every(env.CAMERA_ALERTS_INTERVAL_S, "hourly", () =>
  accumulateHourly(ctx, monitorState, Date.now(), env.CAMERA_ALERTS_INTERVAL_S),
);
every(env.STATUS_SAMPLE_INTERVAL_S, "status-samples", () => sampleStatus(ctx, monitorState));
every(env.NOTIFY_INTERVAL_S, "notify", async () => {
  const r = await notifyAlerts(ctx, monitorState);
  if (r.sent || r.failed) log.info(r, "e-mails de alerta");
});

// Movimento: gravação só com movimento (mantém o que teve movimento) e alarme.
every(20, "motion-keep", async () => {
  const n = await keepMotion(ctx);
  if (n) log.debug({ n }, "segmentos mantidos por movimento");
});
every(5, "alarms", async () => {
  const r = await processAlarms(ctx);
  if (r.notified || r.failed) log.info(r, "alarme");
});

every(60, "housekeeping", async () => {
  const n = await withScope(pool, PLATFORM, (c) => recoverStaleJobs(c));
  if (n) log.warn({ n }, "tarefas presas devolvidas à fila");
});
every(3600, "prune", () =>
  withScope(pool, PLATFORM, async (c) => {
    await pruneJobs(c);
    await pruneDeletedSegments(c);
    await c.query("DELETE FROM motion_events WHERE ended_at < now() - interval '40 days'");
    await c.query("DELETE FROM alarm_notifications WHERE created_at < now() - interval '90 days'");
  }),
);

log.info("worker iniciado");
// Várias tarefas em paralelo (ex.: validar 5 câmeras que entram ao mesmo tempo).
const loop = Promise.all(Array.from({ length: env.WORKER_CONCURRENCY }, () => jobLoop()));

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, "encerrando");
  wakeAll();
  await loop.catch(() => undefined);
  sub.disconnect();
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
