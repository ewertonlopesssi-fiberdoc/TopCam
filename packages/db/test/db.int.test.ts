import { cp, mkdtemp, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { decryptStreamKey, hashStreamKey, parseEncryptionKey } from "@topcam/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrate } from "../src/migrate.js";
import { createPool, withScope, type Pool } from "../src/pool.js";
import { seed } from "../src/seed.js";
import { createTestDb, ownerQuery, type TestDb } from "./helpers.js";

let db: TestDb;
let pool: Pool;

beforeAll(async () => {
  db = await createTestDb();
  pool = createPool(db.appUrl, 4);
});

afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

async function schemaFingerprint(): Promise<string> {
  const rows = await ownerQuery<{ f: string }>(
    db,
    `
    SELECT md5(string_agg(table_name || '.' || column_name || ':' || data_type || ':' || is_nullable, ',' ORDER BY table_name, column_name)) AS f
      FROM information_schema.columns WHERE table_schema = 'public'`,
  );
  return rows[0]!.f;
}

describe("migrations", () => {
  it("reaplicar não altera nada", async () => {
    const before = await schemaFingerprint();
    const res = await migrate(db.ownerUrl);
    expect(res.applied).toEqual([]);
    expect(res.skipped.length).toBeGreaterThanOrEqual(2);
    expect(await schemaFingerprint()).toBe(before);
  });

  it("recusa migration alterada depois de aplicada", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "topcam-mig-"));
    await cp(MIGRATIONS_DIR, dir, { recursive: true });
    await appendFile(path.join(dir, "0001_schema.sql"), "\n-- alterado\n");
    await expect(migrate(db.ownerUrl, { dir })).rejects.toThrow(/alterada depois de aplicada/);
  });

  it("toda tabela com tenant_id tem RLS habilitada", async () => {
    const rows = await ownerQuery<{ relname: string; relrowsecurity: boolean }>(
      db,
      `
      SELECT c.relname, c.relrowsecurity
        FROM pg_class c JOIN information_schema.columns col
          ON col.table_name = c.relname AND col.table_schema = 'public' AND col.column_name = 'tenant_id'
       WHERE c.relkind = 'r'`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(11);
    for (const r of rows) expect(r.relrowsecurity, r.relname).toBe(true);
  });
});

describe("isolamento entre clientes (RLS)", () => {
  async function tenantId(slug: string): Promise<string> {
    return (
      await ownerQuery<{ id: string }>(db, "SELECT id FROM tenants WHERE slug = $1", [slug])
    )[0]!.id;
  }

  it("sem escopo definido, o papel da aplicação não vê nenhuma câmera", async () => {
    const c = new pg.Client({ connectionString: db.appUrl });
    await c.connect();
    const r = await c.query("SELECT count(*)::int AS n FROM cameras");
    await c.end();
    expect(r.rows[0].n).toBe(0);
  });

  it("cada cliente vê só as próprias câmeras, mesmo com consulta sem filtro", async () => {
    const sol = await tenantId("condominio-sol");
    const alfa = await tenantId("empresa-alfa");
    const solCams = await withScope(
      pool,
      { kind: "tenant", tenantId: sol },
      async (c) => (await c.query("SELECT tenant_id, code FROM cameras")).rows,
    );
    expect(solCams).toHaveLength(1);
    expect(solCams.every((r) => r.tenant_id === sol)).toBe(true);
    const alfaCams = await withScope(pool, { kind: "tenant", tenantId: alfa }, async (c) =>
      (await c.query("SELECT code FROM cameras ORDER BY code")).rows.map((r) => r.code),
    );
    expect(alfaCams).toEqual(["CAM-001", "CAM-002", "CAM-003", "CAM-004", "CAM-005"]);
    const all = await withScope(
      pool,
      { kind: "platform" },
      async (c) => (await c.query("SELECT count(*)::int AS n FROM cameras")).rows[0].n,
    );
    expect(all).toBe(6);
  });

  it("cliente não altera nem cria dados de outro cliente", async () => {
    const sol = await tenantId("condominio-sol");
    const alfa = await tenantId("empresa-alfa");
    const updated = await withScope(
      pool,
      { kind: "tenant", tenantId: sol },
      async (c) =>
        (await c.query("UPDATE cameras SET name = 'invadida' WHERE tenant_id = $1", [alfa]))
          .rowCount,
    );
    expect(updated).toBe(0);
    await expect(
      withScope(pool, { kind: "tenant", tenantId: sol }, (c) =>
        c.query("INSERT INTO locations (tenant_id, name) VALUES ($1, 'x')", [alfa]),
      ),
    ).rejects.toThrow(/row-level security/);
    const tenants = await withScope(pool, { kind: "tenant", tenantId: sol }, async (c) =>
      (await c.query("SELECT slug FROM tenants")).rows.map((r) => r.slug),
    );
    expect(tenants).toEqual(["condominio-sol"]);
  });

  it("o banco impede câmera de um cliente em local de outro (FK composta)", async () => {
    const sol = await tenantId("condominio-sol");
    const alfaLoc = (
      await ownerQuery<{ id: string }>(
        db,
        "SELECT l.id FROM locations l JOIN tenants t ON t.id = l.tenant_id WHERE t.slug = 'empresa-alfa'",
      )
    )[0]!.id;
    await expect(
      ownerQuery(
        db,
        `INSERT INTO cameras (tenant_id, location_id, code, name, ingest_protocol)
         VALUES ($1, $2, 'X-1', 'x', 'rtsp_pull')`,
        [sol, alfaLoc],
      ),
    ).rejects.toThrow(/foreign key/);
  });
});

describe("auditoria", () => {
  it("é somente de inserção", async () => {
    await withScope(pool, { kind: "platform" }, (c) =>
      c.query("INSERT INTO audit_logs (actor_type, action) VALUES ('system', 'teste')"),
    );
    await expect(
      withScope(pool, { kind: "platform" }, (c) => c.query("UPDATE audit_logs SET action = 'x'")),
    ).rejects.toThrow(/permission denied/);
    await expect(ownerQuery(db, "DELETE FROM audit_logs")).rejects.toThrow(/somente de inserção/);
  });
});

describe("seed e chaves", () => {
  it("é idempotente e não regenera chaves", async () => {
    const before = await ownerQuery(db, "SELECT id, stream_key_hash FROM cameras ORDER BY id");
    await seed(db.ownerUrl, {
      streamKeyEncKey: db.encKeyB64,
      publicHost: "test.local",
      mediamtxApiUrl: "http://mediamtx:9997",
      recordingsPath: "/recordings",
      demo: true,
    });
    const after = await ownerQuery(db, "SELECT id, stream_key_hash FROM cameras ORDER BY id");
    expect(after).toEqual(before);
  });

  it("chaves são exclusivas, cifradas e consistentes com o hash", async () => {
    const rows = await ownerQuery<{ stream_key_hash: string; stream_key_enc: string }>(
      db,
      "SELECT stream_key_hash, stream_key_enc FROM cameras",
    );
    const key = parseEncryptionKey(db.encKeyB64);
    const hashes = new Set<string>();
    for (const r of rows) {
      const plain = decryptStreamKey(r.stream_key_enc, key);
      expect(hashStreamKey(plain)).toBe(r.stream_key_hash);
      expect(r.stream_key_enc).not.toContain(plain);
      hashes.add(r.stream_key_hash);
    }
    expect(hashes.size).toBe(rows.length);
  });

  it("só a CAM-001 da Empresa Alfa tem gravação habilitada", async () => {
    const rows = await ownerQuery<{ slug: string; code: string }>(
      db,
      `SELECT t.slug, c.code FROM cameras c JOIN tenants t ON t.id = c.tenant_id WHERE c.recording_enabled`,
    );
    expect(rows).toEqual([{ slug: "empresa-alfa", code: "CAM-001" }]);
  });
});
