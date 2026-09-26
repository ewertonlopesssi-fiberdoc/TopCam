import pg from "pg";

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

/** Escopo de acesso aplicado pela RLS do PostgreSQL em cada transação. */
export type DbScope = { kind: "platform" } | { kind: "tenant"; tenantId: string };

export const PLATFORM: DbScope = { kind: "platform" };

export function createPool(connectionString: string, max = 10): pg.Pool {
  const pool = new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000 });
  // Erros em conexões ociosas não podem derrubar o processo.
  pool.on("error", (err) => console.error("[db] erro em conexão ociosa:", err.message));
  return pool;
}

/**
 * Executa `fn` numa transação com o escopo de RLS definido. Todas as consultas
 * de negócio da API e do worker passam por aqui.
 */
export async function withScope<T>(
  pool: pg.Pool,
  scope: DbScope,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.scope', $1, true), set_config('app.tenant_id', $2, true)",
      [scope.kind, scope.kind === "tenant" ? scope.tenantId : ""],
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
