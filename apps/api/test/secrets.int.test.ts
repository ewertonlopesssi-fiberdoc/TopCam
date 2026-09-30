import { randomBytes } from "node:crypto";
import { PLATFORM, createPool, reencryptSecrets, withScope, type Pool } from "@topcam/db";
import { decryptStreamKey, encryptSecret, parseEncryptionKey } from "@topcam/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, ownerQuery, type TestDb } from "../../../packages/db/test/helpers.js";

/** Troca da STREAM_KEY_ENC_KEY (Fase 8): recifra câmeras e SMTP numa transação. */

let db: TestDb;
let pool: Pool;
let oldKey: Buffer;
const newKey = randomBytes(32);
let plainBefore: Map<string, string>;

beforeAll(async () => {
  db = await createTestDb();
  pool = createPool(db.appUrl, 2);
  oldKey = parseEncryptionKey(db.encKeyB64);
  await ownerQuery(
    db,
    `INSERT INTO system_settings (key, value) VALUES ('integrations.smtp', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [
      JSON.stringify({
        enabled: true,
        host: "smtp.teste",
        password_enc: encryptSecret("senha-smtp", oldKey),
      }),
    ],
  );
  await ownerQuery(
    db,
    `INSERT INTO system_settings (key, value) VALUES ('integrations.backup', $1)`,
    [
      JSON.stringify({
        host: "b.teste",
        password_enc: encryptSecret("senha-destino", oldKey),
        private_key_enc: null,
        passphrase_enc: encryptSecret("senha-do-backup-longa", oldKey),
      }),
    ],
  );
  // Uma câmera excluída também precisa ser recifrada.
  await ownerQuery(db, "UPDATE cameras SET deleted_at = now() WHERE code = 'CAM-002'");
  const rows = await ownerQuery<{ id: string; stream_key_enc: string }>(
    db,
    "SELECT id, stream_key_enc FROM cameras WHERE stream_key_enc IS NOT NULL",
  );
  plainBefore = new Map(rows.map((r) => [r.id, decryptStreamKey(r.stream_key_enc, oldKey)]));
});

afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

const encRows = () =>
  ownerQuery<{ id: string; stream_key_enc: string }>(
    db,
    "SELECT id, stream_key_enc FROM cameras WHERE stream_key_enc IS NOT NULL",
  );
const smtpEnc = async () =>
  (
    await ownerQuery<{ enc: string }>(
      db,
      "SELECT value->>'password_enc' AS enc FROM system_settings WHERE key = 'integrations.smtp'",
    )
  )[0]!.enc;

describe("recifragem da chave de cifra", () => {
  it("chave errada como 'antiga': erro e nada muda", async () => {
    const before = await encRows();
    await expect(
      withScope(pool, PLATFORM, (c) => reencryptSecrets(c, randomBytes(32), newKey)),
    ).rejects.toThrow(/não abre com a chave antiga nem com a nova/);
    expect(await encRows()).toEqual(before);
  });

  it("recifra câmeras (inclusive excluídas), senha do SMTP e senhas do backup, mesmo conteúdo", async () => {
    const r = await withScope(pool, PLATFORM, (c) => reencryptSecrets(c, oldKey, newKey));
    expect(r.cameras).toBe(plainBefore.size);
    expect(r.smtp).toBe("reencrypted");
    for (const row of await encRows()) {
      expect(decryptStreamKey(row.stream_key_enc, newKey)).toBe(plainBefore.get(row.id));
      expect(() => decryptStreamKey(row.stream_key_enc, oldKey)).toThrow();
    }
    expect(decryptStreamKey(await smtpEnc(), newKey)).toBe("senha-smtp");
    expect(r.backup).toBe(2);
    const b = (
      await ownerQuery<{ value: Record<string, string | null> }>(
        db,
        "SELECT value FROM system_settings WHERE key = 'integrations.backup'",
      )
    )[0]!.value;
    expect(decryptStreamKey(b.password_enc!, newKey)).toBe("senha-destino");
    expect(decryptStreamKey(b.passphrase_enc!, newKey)).toBe("senha-do-backup-longa");
    expect(b.private_key_enc).toBeNull();
    expect(b.host).toBe("b.teste");
  });

  it("repetir é seguro: o que já está na chave nova fica como está", async () => {
    const r = await withScope(pool, PLATFORM, (c) => reencryptSecrets(c, oldKey, newKey));
    expect(r).toEqual({
      cameras: 0,
      camerasAlreadyNew: plainBefore.size,
      smtp: "already_new",
      backup: 0,
      backupAlreadyNew: 2,
    });
  });

  it("recusa chave nova igual à antiga", async () => {
    await expect(
      withScope(pool, PLATFORM, (c) => reencryptSecrets(c, newKey, newKey)),
    ).rejects.toThrow(/igual/);
  });
});
