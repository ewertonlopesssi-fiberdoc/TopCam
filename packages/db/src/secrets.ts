import { decryptStreamKey, encryptStreamKey } from "@topcam/shared";
import type { PoolClient } from "pg";

/**
 * Troca da chave de cifra (STREAM_KEY_ENC_KEY) — Fase 8.
 *
 * Recifra, numa única transação do chamador, tudo o que o banco guarda cifrado:
 *   - cameras.stream_key_enc (inclusive câmeras excluídas/transferidas);
 *   - a senha do SMTP em system_settings 'integrations.smtp' (password_enc).
 *
 * Cada valor é aberto com a chave antiga, cifrado com a nova e conferido de volta.
 * Valor que já abre com a chave nova é mantido (repetir o comando é seguro).
 * Valor que não abre com nenhuma das duas → erro, e a transação inteira é desfeita.
 */
export interface ReencryptResult {
  cameras: number;
  camerasAlreadyNew: number;
  smtp: "reencrypted" | "already_new" | "none";
}

function recipher(payload: string, oldKey: Buffer, newKey: Buffer, what: string) {
  let plain: string;
  try {
    plain = decryptStreamKey(payload, oldKey);
  } catch {
    try {
      decryptStreamKey(payload, newKey);
      return null; // já está na chave nova
    } catch {
      throw new Error(`${what}: não abre com a chave antiga nem com a nova`);
    }
  }
  const next = encryptStreamKey(plain, newKey);
  if (decryptStreamKey(next, newKey) !== plain) throw new Error(`${what}: conferência falhou`);
  return next;
}

export async function reencryptSecrets(
  c: PoolClient,
  oldKey: Buffer,
  newKey: Buffer,
): Promise<ReencryptResult> {
  if (oldKey.equals(newKey)) throw new Error("a chave nova é igual à antiga");
  const out: ReencryptResult = { cameras: 0, camerasAlreadyNew: 0, smtp: "none" };

  const cams = await c.query<{ id: string; code: string; stream_key_enc: string }>(
    "SELECT id, code, stream_key_enc FROM cameras WHERE stream_key_enc IS NOT NULL FOR UPDATE",
  );
  for (const cam of cams.rows) {
    const next = recipher(cam.stream_key_enc, oldKey, newKey, `câmera ${cam.code}`);
    if (next === null) {
      out.camerasAlreadyNew++;
      continue;
    }
    await c.query("UPDATE cameras SET stream_key_enc = $2 WHERE id = $1", [cam.id, next]);
    out.cameras++;
  }

  const smtp = await c.query<{ value: { password_enc?: string | null } }>(
    "SELECT value FROM system_settings WHERE key = 'integrations.smtp' FOR UPDATE",
  );
  const enc = smtp.rows[0]?.value.password_enc;
  if (enc) {
    const next = recipher(enc, oldKey, newKey, "senha do SMTP");
    if (next === null) out.smtp = "already_new";
    else {
      await c.query(
        `UPDATE system_settings SET value = jsonb_set(value, '{password_enc}', to_jsonb($1::text))
          WHERE key = 'integrations.smtp'`,
        [next],
      );
      out.smtp = "reencrypted";
    }
  }
  return out;
}
