import { createPool, type Pool } from "@topcam/db";
import { encryptSecret, lastScheduledSlot, parseEncryptionKey } from "@topcam/shared";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, ownerQuery, type TestDb } from "../../../packages/db/test/helpers.js";
import { recoverInterrupted, tick, type BackupContext } from "../src/backup/service.js";

/**
 * Serviço de backup (Fase 8): agenda com até 3 tentativas (30 min entre elas), pedidos do
 * painel antes da agenda, alertas de falha e de atraso. O banco "do dono" aponta para uma
 * porta fechada, então todo backup falha rápido no dump — é o caminho de erro que interessa.
 */

let db: TestDb;
let pool: Pool;
let ctx: BackupContext;

beforeAll(async () => {
  db = await createTestDb();
  pool = createPool(db.appUrl, 2);
  ctx = {
    pool,
    log: pino({ level: "silent" }),
    encKey: parseEncryptionKey(db.encKeyB64),
    ownerDb: { host: "127.0.0.1", port: 1, user: "x", password: "x", database: "x" },
    envFile: "/nao/existe/.env",
    backupDir: "/tmp/topcam-backup-teste",
    appVersion: "teste",
    publicHost: "localhost",
  };
});

afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

async function settings(extra: Record<string, unknown>) {
  const key = parseEncryptionKey(db.encKeyB64);
  const value = {
    enabled: true,
    protocol: "sftp",
    host: "backup.invalid",
    port: 22,
    username: "bkp",
    auth: "password",
    password_enc: encryptSecret("senha", key),
    path: "topcam",
    schedule_time: "03:30",
    retention_remote: 3,
    retention_local: 1,
    passphrase_enc: encryptSecret("senha-do-backup-longa", key),
    enabled_at: new Date().toISOString(),
    ...extra,
  };
  await ownerQuery(
    db,
    `INSERT INTO system_settings (key, value) VALUES ('integrations.backup', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(value)],
  );
}
const runs = () =>
  ownerQuery<{ kind: string; trigger: string; status: string; error: string | null }>(
    db,
    "SELECT kind, trigger, status, error FROM backup_runs ORDER BY id",
  );
const alert = (key: string) =>
  ownerQuery<{ status: string; title: string }>(
    db,
    "SELECT status, title FROM alerts WHERE dedup_key = $1 ORDER BY id DESC LIMIT 1",
    [key],
  );

beforeEach(async () => {
  await ownerQuery(db, "DELETE FROM backup_runs");
  await ownerQuery(db, "DELETE FROM alerts");
  await ownerQuery(db, "DELETE FROM system_settings WHERE key = 'integrations.backup'");
});

describe("agenda do backup", () => {
  it("desligado ou sem senha do backup: não agenda", async () => {
    await settings({ enabled: false });
    expect(await tick(ctx)).toBeNull();
    await settings({ passphrase_enc: null });
    expect(await tick(ctx)).toBeNull();
    expect(await runs()).toEqual([]);
  });

  it("no horário: roda; falha → alerta; novas tentativas só após 30 min, no máximo 3", async () => {
    await settings({});
    const slot = lastScheduledSlot(new Date(), "03:30");
    const at = (min: number) => new Date(Math.max(Date.now(), slot.getTime()) + min * 60_000);

    const r1 = await tick(ctx, at(0));
    expect(r1).toMatchObject({ kind: "backup", trigger: "schedule" });
    let all = await runs();
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe("failed");
    expect(all[0]!.error).toMatch(/Falha no dump do banco/);
    const a = await alert("backup.failed");
    expect(a[0]).toMatchObject({ status: "open" });
    expect(a[0]!.title).toMatch(/^Backup falhou: Falha no dump/);

    expect(await tick(ctx, at(5))).toBeNull(); // cedo demais para tentar de novo
    expect(await tick(ctx, at(31))).not.toBeNull(); // 2ª tentativa
    expect(await tick(ctx, at(62))).not.toBeNull(); // 3ª tentativa
    expect(await tick(ctx, at(93))).toBeNull(); // chega de tentativas até o próximo horário
    all = await runs();
    expect(all).toHaveLength(3);
    expect(all.every((r) => r.trigger === "schedule" && r.status === "failed")).toBe(true);
    // Um alerta só (atualizado), não três.
    const n = await ownerQuery(db, "SELECT 1 FROM alerts WHERE dedup_key = 'backup.failed'");
    expect(n).toHaveLength(1);
  });

  it("já houve sucesso desde o horário: não roda de novo", async () => {
    await settings({});
    await ownerQuery(
      db,
      `INSERT INTO backup_runs (kind, trigger, status, started_at, finished_at)
       VALUES ('backup', 'schedule', 'success', now(), now())`,
    );
    expect(await tick(ctx)).toBeNull();
  });

  it("pedido do painel vem antes da agenda", async () => {
    await settings({});
    await ownerQuery(db, "INSERT INTO backup_runs (kind, trigger) VALUES ('test', 'manual')");
    const r = await tick(ctx);
    expect(r).toMatchObject({ kind: "test", trigger: "manual" });
    const all = await runs();
    expect(all[0]).toMatchObject({ kind: "test", status: "failed" });
    // Teste que falha não abre alerta de backup.
    expect(await alert("backup.failed")).toEqual([]);
  });

  it("serviço reiniciado no meio: execução marcada como interrompida", async () => {
    await ownerQuery(
      db,
      "INSERT INTO backup_runs (kind, trigger, status, started_at) VALUES ('backup', 'manual', 'running', now())",
    );
    await recoverInterrupted(ctx);
    expect((await runs())[0]).toMatchObject({ status: "failed" });
    expect((await runs())[0]!.error).toMatch(/Interrompido/);
  });
});

describe("alerta de atraso (26 h sem backup concluído)", () => {
  it("ligado há 27 h sem nenhum sucesso → alerta; desligar resolve", async () => {
    await settings({
      enabled_at: new Date(Date.now() - 27 * 3_600_000).toISOString(),
      schedule_time: "00:00",
    });
    // Sucesso "agendado" hoje para não disparar a agenda; mas antigo o bastante para atrasar.
    await ownerQuery(
      db,
      `INSERT INTO backup_runs (kind, trigger, status, created_at, started_at, finished_at)
       VALUES ('backup', 'schedule', 'success', now(), now() - interval '27 hours', now() - interval '27 hours')`,
    );
    await tick(ctx);
    expect((await alert("backup.stale"))[0]).toMatchObject({ status: "open" });
    await settings({ enabled: false });
    await tick(ctx);
    expect((await alert("backup.stale"))[0]).toMatchObject({ status: "resolved" });
  });
});
