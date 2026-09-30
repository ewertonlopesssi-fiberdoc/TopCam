import { createPool } from "@topcam/db";
import { parseEncryptionKey } from "@topcam/shared";
import { pino } from "pino";
import { z } from "zod";
import { heartbeat, recoverInterrupted, tick, type BackupContext } from "./backup/service.js";

/**
 * Serviço de backup (Fase 8, parte 3) — contêiner próprio, o único com a senha do dono do
 * banco (pg_dump precisa enxergar todos os clientes). Executa um pedido por vez:
 * teste de conexão e backup agora (pedidos do painel) e o backup diário agendado.
 */
const env = z
  .object({
    LOG_LEVEL: z.string().default("info"),
    DATABASE_URL: z.string().min(1),
    STREAM_KEY_ENC_KEY: z.string().min(40),
    BACKUP_DB_HOST: z.string().default("postgres"),
    BACKUP_DB_PORT: z.coerce.number().int().default(5432),
    BACKUP_DB_USER: z.string().default("topcam_owner"),
    BACKUP_DB_PASSWORD: z.string().min(1),
    BACKUP_DB_NAME: z.string().default("topcam"),
    BACKUP_ENV_FILE: z.string().default("/topcam/.env"),
    BACKUP_DIR: z.string().default("/backups"),
    BACKUP_POLL_S: z.coerce.number().positive().default(5),
    PUBLIC_HOST: z.string().default("localhost"),
    TOPCAM_VERSION: z.string().default("0.1.0"),
  })
  .parse(process.env);

const log = pino({ level: env.LOG_LEVEL, base: { svc: "backup" } });
const pool = createPool(env.DATABASE_URL, 3);
const ctx: BackupContext = {
  pool,
  log,
  encKey: parseEncryptionKey(env.STREAM_KEY_ENC_KEY),
  ownerDb: {
    host: env.BACKUP_DB_HOST,
    port: env.BACKUP_DB_PORT,
    user: env.BACKUP_DB_USER,
    password: env.BACKUP_DB_PASSWORD,
    database: env.BACKUP_DB_NAME,
  },
  envFile: env.BACKUP_ENV_FILE,
  backupDir: env.BACKUP_DIR,
  appVersion: env.TOPCAM_VERSION,
  publicHost: env.PUBLIC_HOST,
};

let stopping = false;
const stop = () => {
  stopping = true;
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

await recoverInterrupted(ctx).catch((err) =>
  log.error({ err: (err as Error).message }, "recuperação"),
);
log.info("serviço de backup no ar");
let lastBeat = 0;
while (!stopping) {
  try {
    if (Date.now() - lastBeat > 30_000) {
      await heartbeat(ctx, null);
      lastBeat = Date.now();
    }
    if (await tick(ctx)) lastBeat = 0;
  } catch (err) {
    log.error({ err: (err as Error).message }, "falha no laço do backup");
  }
  await new Promise((r) => setTimeout(r, env.BACKUP_POLL_S * 1000));
}
await pool.end();
log.info("serviço de backup encerrado");
