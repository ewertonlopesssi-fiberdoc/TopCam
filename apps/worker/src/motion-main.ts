import { createPool } from "@topcam/db";
import { readFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createSecureContext, type SecureContext } from "node:tls";
import { pino } from "pino";
import { z } from "zod";
import { createEventsSmtpServer } from "./events/smtp.js";
import { MotionManager } from "./motion/manager.js";

/**
 * Serviço de movimento (contêiner "motion"), separado do worker para não disputar CPU:
 *  - receptor de eventos por e-mail (SMTP) das câmeras com detecção própria;
 *  - detector do servidor (ffmpeg, só quadros-chave) para as câmeras sem aviso próprio.
 * Os dois gravam em motion_events. Alarme e gravação só com movimento ficam com o worker.
 */
const env = z
  .object({
    LOG_LEVEL: z.string().default("info"),
    DATABASE_URL: z.string().min(1),
    PUBLIC_HOST: z.string().default("localhost"),
    EVENTS_SMTP_PORT: z.coerce.number().int().positive().default(2525),
    /** Certificado do painel copiado pelo serviço do host (o mesmo do RTMPS). */
    EVENTS_TLS_DIR: z.string().default("/tls"),
    EVENTS_AUTH_MAX_FAILURES: z.coerce.number().int().positive().default(10),
    EVENTS_AUTH_BLOCK_S: z.coerce.number().int().positive().default(1800),
    EVENTS_PER_CAMERA_PER_HOUR: z.coerce.number().int().positive().default(720),
    MEDIAMTX_RTSP_URL: z.string().default("rtsp://mediamtx:8554"),
    MEDIA_READ_USER: z.string().min(3).default("topcam-internal"),
    MEDIA_READ_PASSWORD: z.string().min(24),
    MOTION_SYNC_S: z.coerce.number().positive().default(15),
    MOTION_MAX_DETECTORS: z.coerce.number().int().positive().default(64),
  })
  .parse(process.env);

const log = pino({ level: env.LOG_LEVEL, base: { svc: "motion" } });
const pool = createPool(env.DATABASE_URL, 5);

// ------------------------------------------------------------------ receptor SMTP
// Certificado: lido no início e relido quando o arquivo muda (renovação a cada ~60 dias).
const crtFile = `${env.EVENTS_TLS_DIR}/server.crt`;
const keyFile = `${env.EVENTS_TLS_DIR}/server.key`;
let tlsMtime = 0;
let tlsPem: { key: Buffer; cert: Buffer } | null = null;
let tlsCtx: SecureContext | undefined;
function loadTls(): void {
  try {
    const m = statSync(crtFile).mtimeMs;
    if (m === tlsMtime) return;
    tlsPem = { key: readFileSync(keyFile), cert: readFileSync(crtFile) };
    tlsCtx = createSecureContext(tlsPem);
    tlsMtime = m;
    log.info("eventos: certificado carregado para o STARTTLS");
  } catch {
    // Sem HTTPS (laboratório): o smtp-server usa um certificado próprio.
  }
}
loadTls();
setInterval(loadTls, 10 * 60_000).unref();

const server = createEventsSmtpServer({
  pool,
  log,
  name: env.PUBLIC_HOST,
  tls: tlsPem,
  sniCallback: tlsPem ? (_servername, cb) => cb(null, tlsCtx) : undefined,
  authMaxFailures: env.EVENTS_AUTH_MAX_FAILURES,
  authBlockS: env.EVENTS_AUTH_BLOCK_S,
  perCameraPerHour: env.EVENTS_PER_CAMERA_PER_HOUR,
});
server.on("error", (err) => log.warn({ err: err.message }, "eventos: erro de conexão"));
server.listen(env.EVENTS_SMTP_PORT, "0.0.0.0", () =>
  log.info({ port: env.EVENTS_SMTP_PORT }, "receptor de eventos no ar"),
);

// ------------------------------------------------------------------ detector do servidor
const rtspBase = env.MEDIAMTX_RTSP_URL.replace(
  "rtsp://",
  `rtsp://${encodeURIComponent(env.MEDIA_READ_USER)}:${encodeURIComponent(env.MEDIA_READ_PASSWORD)}@`,
);
const manager = new MotionManager({ pool, log, rtspBase, maxDetectors: env.MOTION_MAX_DETECTORS });
let stopping = false;
let lastCount = -1;
async function syncLoop() {
  if (stopping) return;
  try {
    const r = await manager.sync();
    if (r.running !== lastCount) log.info(r, "detector de movimento: câmeras");
    lastCount = r.running;
    // Heartbeat para o healthcheck do contêiner.
    await writeFile("/tmp/motion-heartbeat", String(Date.now())).catch(() => undefined);
  } catch (err) {
    log.error({ err: (err as Error).message }, "detector de movimento: falha ao sincronizar");
  }
  if (!stopping) setTimeout(() => void syncLoop(), env.MOTION_SYNC_S * 1000);
}
void syncLoop();

function shutdown() {
  stopping = true;
  manager.stopAll();
  server.close(() => {
    void pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
