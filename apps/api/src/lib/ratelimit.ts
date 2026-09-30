import type { Redis } from "ioredis";

/**
 * Contador de tentativas em janela fixa no Redis. Se o Redis estiver fora do ar,
 * não bloqueia (o login continua protegido pelo custo do scrypt).
 */
export async function hit(redis: Redis, key: string, windowS: number): Promise<number> {
  try {
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, windowS);
    return n;
  } catch {
    return 0;
  }
}

export async function count(redis: Redis, key: string): Promise<number> {
  try {
    return Number((await redis.get(key)) ?? 0);
  } catch {
    return 0;
  }
}

export async function reset(redis: Redis, key: string): Promise<void> {
  await redis.del(key).catch(() => undefined);
}

/**
 * Janela fixa com limite: soma 1 e diz se passou do máximo e quantos segundos faltam
 * para a janela acabar. Redis fora do ar → nunca bloqueia.
 */
export async function limitHit(
  redis: Redis,
  key: string,
  max: number,
  windowS: number,
): Promise<{ over: boolean; retryAfterS: number; count: number }> {
  try {
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, windowS);
    if (n <= max) return { over: false, retryAfterS: 0, count: n };
    const ttl = await redis.ttl(key);
    return { over: true, retryAfterS: ttl > 0 ? ttl : windowS, count: n };
  } catch {
    return { over: false, retryAfterS: 0, count: 0 };
  }
}

/** "Aguarde 3 minutos" / "Aguarde 40 segundos". */
export function waitText(seconds: number): string {
  return seconds >= 90 ? `${Math.ceil(seconds / 60)} minutos` : `${Math.max(1, seconds)} segundos`;
}
