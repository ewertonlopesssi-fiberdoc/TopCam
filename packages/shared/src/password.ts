import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Hash de senha com scrypt (nativo do Node, sem dependência compilada).
 * Formato: scrypt$N$r$p$<salt b64>$<hash b64>
 */

const N = 32768;
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 128 * N * R * 2;

function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  opts: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return ["scrypt", N, R, P, salt.toString("base64"), hash.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, saltB64, hashB64] = stored.split("$");
  if (alg !== "scrypt" || !n || !r || !p || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const cost = { N: Number(n), r: Number(r), p: Number(p) };
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, {
    ...cost,
    maxmem: 128 * cost.N * cost.r * 2,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Regra de senha exibida nas telas. */
export const PASSWORD_RULE =
  "Mínimo de 8 caracteres, com 1 letra maiúscula, 1 minúscula e 1 número.";

/**
 * Política de senha: mínimo 8 caracteres, com ao menos 1 maiúscula, 1 minúscula e 1 número.
 * Retorna a mensagem de erro ou null. O segundo parâmetro (e-mail) é aceito por
 * compatibilidade e não é mais usado.
 */
export function validatePassword(password: string, _email?: string): string | null {
  if (password.length < 8) return "A senha deve ter pelo menos 8 caracteres.";
  if (password.length > 200) return "A senha deve ter no máximo 200 caracteres.";
  if (!/[A-Z]/.test(password)) return "A senha deve ter ao menos 1 letra maiúscula.";
  if (!/[a-z]/.test(password)) return "A senha deve ter ao menos 1 letra minúscula.";
  if (!/[0-9]/.test(password)) return "A senha deve ter ao menos 1 número.";
  return null;
}

/** Senha temporária legível (sem caracteres ambíguos), usada em criação e redefinição. */
export function generateTempPassword(length = 14): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnpqrstuvwxyz";
  const digits = "23456789";
  const alphabet = upper + lower + digits;
  for (;;) {
    const bytes = randomBytes(length);
    let out = "";
    for (let i = 0; i < length; i++) out += alphabet[bytes[i]! % alphabet.length];
    // Sempre atende à política (maiúscula, minúscula e número).
    if (validatePassword(out) === null) return out;
  }
}
