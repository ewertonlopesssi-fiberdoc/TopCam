#!/usr/bin/env node
import { migrate, setAppRolePassword } from "./migrate.js";
import { seed } from "./seed.js";

/**
 * Uso:
 *   topcam-db migrate   → aplica migrations e define a senha do papel topcam_app
 *   topcam-db seed      → dados de referência (+ demonstração se SEED_DEMO=true)
 *   topcam-db setup     → migrate + seed (usado pelo serviço "migrate" do Compose)
 *
 * Variáveis: MIGRATION_DATABASE_URL (dono do banco), APP_DB_PASSWORD,
 * STREAM_KEY_ENC_KEY, PUBLIC_HOST, MEDIAMTX_API_URL, RECORDINGS_PATH,
 * VIDEO_QUOTA_BYTES, ADMIN_EMAIL, ADMIN_INITIAL_PASSWORD, SEED_DEMO.
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[db] variável obrigatória ausente: ${name}`);
    process.exit(2);
  }
  return v;
}

const log = (msg: string) => console.log(`[db] ${msg}`);

async function runMigrate() {
  const url = required("MIGRATION_DATABASE_URL");
  const res = await migrate(url, { log });
  log(
    `migrations aplicadas: ${res.applied.length} (${res.applied.join(", ") || "nenhuma"}); já aplicadas: ${res.skipped.length}`,
  );
  await setAppRolePassword(url, required("APP_DB_PASSWORD"));
  log("senha do papel topcam_app configurada");
}

async function runSeed() {
  await seed(required("MIGRATION_DATABASE_URL"), {
    streamKeyEncKey: required("STREAM_KEY_ENC_KEY"),
    publicHost: process.env.PUBLIC_HOST ?? "localhost",
    mediamtxApiUrl: process.env.MEDIAMTX_API_URL ?? "http://mediamtx:9997",
    recordingsPath: process.env.RECORDINGS_PATH ?? "/recordings",
    videoQuotaBytes: process.env.VIDEO_QUOTA_BYTES
      ? Number(process.env.VIDEO_QUOTA_BYTES)
      : undefined,
    adminEmail: process.env.ADMIN_EMAIL || undefined,
    adminPassword: process.env.ADMIN_INITIAL_PASSWORD || undefined,
    demo: process.env.SEED_DEMO === "true",
    log,
  });
  log("seed concluído");
}

const cmd = process.argv[2];
try {
  if (cmd === "migrate") await runMigrate();
  else if (cmd === "seed") await runSeed();
  else if (cmd === "setup") {
    await runMigrate();
    await runSeed();
  } else {
    console.error("uso: topcam-db <migrate|seed|setup>");
    process.exit(2);
  }
} catch (err) {
  console.error(`[db] ERRO: ${(err as Error).message}`);
  process.exit(1);
}
