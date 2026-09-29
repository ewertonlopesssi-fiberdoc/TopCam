import { randomBytes } from "node:crypto";
import pg from "pg";
import { migrate, setAppRolePassword } from "../src/migrate.js";
import { seed } from "../src/seed.js";

/**
 * Cria um banco temporário isolado para cada suíte de integração, aplica as
 * migrations e o seed de demonstração. Requer um Postgres acessível com um
 * usuário que possa criar bancos (TEST_ADMIN_DATABASE_URL).
 */

export const ADMIN_URL =
  process.env.TEST_ADMIN_DATABASE_URL ??
  "postgres://topcam_owner:ownerpass@127.0.0.1:55432/postgres";
export const APP_PASSWORD = process.env.APP_DB_PASSWORD ?? "apppassword-1234567";
export const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6379/15";

export interface TestDb {
  name: string;
  ownerUrl: string;
  appUrl: string;
  encKeyB64: string;
  drop: () => Promise<void>;
}

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

const ROLE_LOCK_KEY = 7_311_004;

export async function createTestDb(opts: { seedDemo?: boolean } = {}): Promise<TestDb> {
  const name = `topcam_test_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const ownerUrl = withDatabase(ADMIN_URL, name);
  // O papel topcam_app é do servidor inteiro, não do banco: com os arquivos de teste
  // em paralelo, criar/alterar o papel ao mesmo tempo dá "tuple concurrently updated".
  // Uma trava no banco "postgres" (comum a todos) faz essa etapa um de cada vez.
  const lock = new pg.Client({ connectionString: ADMIN_URL });
  await lock.connect();
  try {
    await lock.query("SELECT pg_advisory_lock($1)", [ROLE_LOCK_KEY]);
    await migrate(ownerUrl);
    await setAppRolePassword(ownerUrl, APP_PASSWORD);
  } finally {
    await lock.query("SELECT pg_advisory_unlock($1)", [ROLE_LOCK_KEY]).catch(() => undefined);
    await lock.end();
  }
  const encKeyB64 = randomBytes(32).toString("base64");
  if (opts.seedDemo !== false) {
    await seed(ownerUrl, {
      streamKeyEncKey: encKeyB64,
      publicHost: "test.local",
      mediamtxApiUrl: "http://mediamtx:9997",
      recordingsPath: "/recordings",
      demo: true,
      adminEmail: "admin@test.local",
      adminPassword: "senha-de-teste-123",
    });
  }
  const app = new URL(ownerUrl);
  app.username = "topcam_app";
  app.password = APP_PASSWORD;

  return {
    name,
    ownerUrl,
    appUrl: app.toString(),
    encKeyB64,
    drop: async () => {
      const c = new pg.Client({ connectionString: ADMIN_URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}

export async function ownerQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  db: TestDb,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const c = new pg.Client({ connectionString: db.ownerUrl });
  await c.connect();
  try {
    return (await c.query<T>(sql, params)).rows;
  } finally {
    await c.end();
  }
}
