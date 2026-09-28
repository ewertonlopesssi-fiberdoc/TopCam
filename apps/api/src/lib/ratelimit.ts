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
