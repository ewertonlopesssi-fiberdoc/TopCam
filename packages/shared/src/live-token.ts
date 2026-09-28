import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Token do ao vivo: vai no caminho da URL (/live/<token>/index.m3u8) para que os
 * pedidos relativos do HLS (playlists, partes, segmentos) também saiam autenticados.
 *
 * Formato: v1.<payload base64url>.<HMAC-SHA256 base64url>
 * Payload: { c: câmera, u: usuário, s: sessão, e: expiração (epoch s) }
 *
 * O token não contém a chave RTMP nem o caminho interno. A cada pedido o gateway
 * pergunta à API, que confere a assinatura, a validade e — com cache curto — se a
 * sessão, o usuário, o cliente, a câmera e a permissão continuam valendo.
 */

export interface LiveClaims {
  c: string;
  u: string;
  s: string;
  e: number;
}

const PREFIX = "v1";

function key(secret: string): Buffer {
  // Chave derivada: um token do ao vivo nunca serve como token de acesso (e vice-versa).
  return createHmac("sha256", secret).update("topcam-live-token-v1").digest();
}

function sign(secret: string, data: string): string {
  return createHmac("sha256", key(secret)).update(data).digest("base64url");
}

export function signLiveToken(secret: string, claims: LiveClaims): string {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${PREFIX}.${body}.${sign(secret, `${PREFIX}.${body}`)}`;
}

export type LiveTokenResult =
  | { ok: true; claims: LiveClaims }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function verifyLiveToken(
  secret: string,
  token: string,
  nowS = Math.floor(Date.now() / 1000),
): LiveTokenResult {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX || !parts[1] || !parts[2])
    return { ok: false, reason: "malformed" };
  const expected = Buffer.from(sign(secret, `${parts[0]}.${parts[1]}`));
  const got = Buffer.from(parts[2]);
  if (expected.length !== got.length || !timingSafeEqual(expected, got))
    return { ok: false, reason: "bad_signature" };
  let claims: LiveClaims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as LiveClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof claims.c !== "string" ||
    typeof claims.u !== "string" ||
    typeof claims.s !== "string" ||
    typeof claims.e !== "number"
  )
    return { ok: false, reason: "malformed" };
  if (claims.e <= nowS) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}

/**
 * Recursos que o navegador pode pedir depois do token. Tudo o mais é recusado
 * (ex.: a página HTML de teste do MediaMTX, outros caminhos, "..").
 *   HLS:  index.m3u8, <variante>.m3u8, <init|segmento|parte>.mp4
 *   WHEP: whep (POST da oferta) e whep/<sessão> (PATCH/DELETE)
 */
const HLS_FILE = /^[A-Za-z0-9_-]{1,80}\.(m3u8|mp4)$/;
const WHEP = /^whep(\/[A-Za-z0-9-]{1,64})?$/;

export function parseLivePath(
  uri: string,
): { token: string; rest: string; kind: "hls" | "whep"; query: string } | null {
  const [path = "", query = ""] = uri.split("?", 2);
  const m = /^(?:\/live)?\/([A-Za-z0-9._-]{20,600})\/(.+)$/.exec(path);
  if (!m) return null;
  const [, token, rest] = m as unknown as [string, string, string];
  if (HLS_FILE.test(rest)) return { token, rest, kind: "hls", query };
  if (WHEP.test(rest)) return { token, rest, kind: "whep", query };
  return null;
}
