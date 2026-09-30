import { BlockList, isIPv4, isIPv6 } from "node:net";
import { PLATFORM, insertCameraEvent, withScope } from "@topcam/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { HttpError } from "../lib/http.js";
import { limitHit, waitText } from "../lib/ratelimit.js";

/**
 * Limite de requisições (Fase 8).
 *
 * 1. Geral, por IP, em /api/* (exceto /api/v1/health): RATE_LIMIT_API_PER_MIN por minuto.
 *    Ficam de fora: loopback, redes privadas 172.16.0.0/12 (rede interna e do Docker) e as
 *    redes liberadas no firewall do painel (Configurações → Firewall).
 * 2. Por ação sensível (app.rateLimit): chave = usuário autenticado ou, sem login, o IP.
 *
 * Estouro → 429 em português com Retry-After. Nada disso vale para /internal/* (servidor
 * de mídia e gateway), que tem o próprio controle.
 */

const FIXED_TRUSTED: [string, number][] = [
  ["127.0.0.0", 8],
  ["172.16.0.0", 12],
];
const TRUSTED_CACHE_MS = 60_000;

declare module "fastify" {
  interface FastifyInstance {
    rateLimit: (
      name: string,
      max: number,
      windowS: number,
      opts?: { skipTrusted?: boolean },
    ) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    isTrustedIp: (ip: string) => Promise<boolean>;
  }
}

function tooMany(reply: FastifyReply, retryAfterS: number, what: string): HttpError {
  reply.header("Retry-After", String(retryAfterS));
  return new HttpError(
    429,
    "too_many_requests",
    `Muitas solicitações ${what}. Aguarde ${waitText(retryAfterS)} e tente de novo.`,
  );
}

export async function rateLimitPlugin(app: FastifyInstance): Promise<void> {
  const { env, pool, redis } = app.deps;

  let trusted: { list: BlockList; at: number } | null = null;
  async function trustedList(): Promise<BlockList> {
    if (trusted && Date.now() - trusted.at < TRUSTED_CACHE_MS) return trusted.list;
    const list = new BlockList();
    for (const [net, mask] of FIXED_TRUSTED) list.addSubnet(net, mask, "ipv4");
    list.addAddress("::1", "ipv6");
    try {
      const rows = await withScope(
        pool,
        PLATFORM,
        async (c) =>
          (await c.query<{ cidr: string }>("SELECT cidr::text FROM firewall_ssh_networks")).rows,
      );
      for (const { cidr } of rows) {
        const [net, mask] = cidr.split("/");
        if (net && isIPv4(net)) list.addSubnet(net, Number(mask), "ipv4");
        else if (net && isIPv6(net)) list.addSubnet(net, Number(mask), "ipv6");
      }
    } catch {
      /* banco fora do ar: fica só com as redes fixas */
    }
    trusted = { list, at: Date.now() };
    return list;
  }

  app.decorate("isTrustedIp", async (raw: string) => {
    const ip = raw.startsWith("::ffff:") ? raw.slice(7) : raw;
    const list = await trustedList();
    if (isIPv4(ip)) return list.check(ip, "ipv4");
    if (isIPv6(ip)) return list.check(ip, "ipv6");
    return false;
  });

  app.decorate(
    "rateLimit",
    (name: string, max: number, windowS: number, opts: { skipTrusted?: boolean } = {}) =>
      async (req: FastifyRequest, reply: FastifyReply) => {
        if (opts.skipTrusted && (await app.isTrustedIp(req.ip))) return;
        const who = req.user ? `u:${req.user.id}` : `ip:${req.ip}`;
        const r = await limitHit(redis, `topcam:rl:${name}:${who}`, max, windowS);
        if (r.over) {
          req.log.warn(
            { limit: name, who: req.user ? "usuário" : req.ip },
            "limite de ação atingido",
          );
          throw tooMany(reply, r.retryAfterS, "desta ação");
        }
      },
  );

  const perMin = env.RATE_LIMIT_API_PER_MIN;
  if (perMin <= 0) return; // 0 desliga o limite geral
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0]!;
    if (!path.startsWith("/api/") || path === "/api/v1/health") return;
    if (await app.isTrustedIp(req.ip)) return;
    const r = await limitHit(redis, `topcam:rl:api:${req.ip}`, perMin, 60);
    if (!r.over) return;
    // Um registro por IP a cada 10 minutos (tela Eventos), sem inundar o banco.
    try {
      const first = await redis.set(`topcam:evt:rl-api:${req.ip}`, "1", "EX", 600, "NX");
      if (first === "OK") {
        req.log.warn({ ip: req.ip }, "limite geral de requisições atingido");
        await withScope(pool, PLATFORM, (c) =>
          insertCameraEvent(c, {
            tenantId: null,
            cameraId: null,
            type: "rate_limited",
            severity: "warning",
            message: `Limite de requisições atingido (${perMin}/min) — acessos deste IP recusados por até 1 minuto`,
            data: { limit_per_min: perMin },
            sourceIp: req.ip,
          }),
        );
      }
    } catch {
      /* registro é melhor esforço */
    }
    throw tooMany(reply, r.retryAfterS, "deste endereço");
  });
}
