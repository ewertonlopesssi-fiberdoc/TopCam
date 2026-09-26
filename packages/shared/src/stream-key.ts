import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";

/**
 * Chaves de transmissão RTMP.
 *
 * - Geradas com 40 caracteres [A-Za-z0-9] (~238 bits de entropia).
 * - Buscadas pelo hash SHA-256 (coluna única em `cameras.stream_key_hash`).
 * - Guardadas também cifradas com AES-256-GCM para que o administrador possa
 *   exibi-las de novo e para que o sistema monte o caminho no servidor de mídia.
 *   A chave de cifra vem de `STREAM_KEY_ENC_KEY` (32 bytes em base64) e nunca
 *   fica no banco.
 */

export const STREAM_KEY_LENGTH = 40;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export const STREAM_KEY_REGEX = /^[A-Za-z0-9]{40}$/;

export function generateStreamKey(): string {
  let out = "";
  for (let i = 0; i < STREAM_KEY_LENGTH; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export function isValidStreamKeyFormat(key: string): boolean {
  return STREAM_KEY_REGEX.test(key);
}

export function hashStreamKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** Prefixo exibível (identifica a chave sem revelá-la). */
export function streamKeyPrefix(key: string): string {
  return key.slice(0, 4);
}

/** Identificador curto para logs de chaves recusadas (não reversível). */
export function fingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

export function parseEncryptionKey(base64: string): Buffer {
  const buf = Buffer.from(base64, "base64");
  if (buf.length !== 32) {
    throw new Error("STREAM_KEY_ENC_KEY deve ter 32 bytes codificados em base64");
  }
  return buf;
}

/** Formato: v1.<iv b64url>.<tag b64url>.<ciphertext b64url> */
export function encryptStreamKey(key: string, encKey: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encKey, iv);
  const ct = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(
    ".",
  );
}

export function decryptStreamKey(payload: string, encKey: Buffer): string {
  const [version, ivB64, tagB64, ctB64] = payload.split(".");
  if (version !== "v1" || !ivB64 || !tagB64 || !ctB64) {
    throw new Error("Formato de chave cifrada desconhecido");
  }
  const decipher = createDecipheriv("aes-256-gcm", encKey, Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
