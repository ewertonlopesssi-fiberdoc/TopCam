import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

/**
 * Executor de migrations SQL versionadas.
 * - Cada arquivo `NNNN_nome.sql` roda uma única vez, dentro de uma transação.
 * - O checksum de cada migration aplicada é conferido: alterar um arquivo já
 *   aplicado é erro (crie uma migration nova).
 * - Um advisory lock impede execuções concorrentes.
 */

const LOCK_ID = 7_310_442_001;

export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

export async function migrate(
  connectionString: string,
  opts: { dir?: string; log?: (msg: string) => void } = {},
): Promise<MigrationResult> {
  const dir = opts.dir ?? MIGRATIONS_DIR;
  const log = opts.log ?? (() => undefined);
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

    const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    const { rows } = await client.query<{ version: string; checksum: string }>(
      "SELECT version, checksum FROM schema_migrations",
    );
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));
    const result: MigrationResult = { applied: [], skipped: [] };

    for (const file of files) {
      const sql = await readFile(path.join(dir, file), "utf8");
      const sum = checksum(sql);
      const previous = applied.get(file);
      if (previous) {
        if (previous !== sum) {
          throw new Error(
            `Migration ${file} foi alterada depois de aplicada (checksum diferente). Crie uma nova migration.`,
          );
        }
        result.skipped.push(file);
        continue;
      }
      log(`aplicando ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)", [
          file,
          sum,
        ]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Falha na migration ${file}: ${(err as Error).message}`, { cause: err });
      }
      result.applied.push(file);
    }
    return result;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => undefined);
    await client.end();
  }
}

/** Define/rotaciona a senha do papel da aplicação (topcam_app) e habilita login. */
export async function setAppRolePassword(
  connectionString: string,
  password: string,
): Promise<void> {
  if (password.length < 16) throw new Error("APP_DB_PASSWORD deve ter pelo menos 16 caracteres");
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(
      `ALTER ROLE topcam_app WITH LOGIN PASSWORD ${client.escapeLiteral(password)}`,
    );
  } finally {
    await client.end();
  }
}
