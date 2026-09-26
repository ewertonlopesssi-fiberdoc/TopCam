import type { Pool } from "@topcam/db";
import { MediaMtxClient } from "@topcam/shared";
import Fastify, { type FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Env } from "./env.js";
import { healthRoutes } from "./routes/health.js";
import { mediamtxRoutes } from "./routes/mediamtx.js";

export interface AppDeps {
  env: Env;
  pool: Pool;
  redis: Redis;
  mediamtx?: MediaMtxClient;
}

declare module "fastify" {
  interface FastifyInstance {
    deps: Required<AppDeps>;
  }
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: deps.env.LOG_LEVEL,
      // Nunca registrar a query string das rotas internas (contém o segredo).
      serializers: {
        req: (req) => ({ method: req.method, url: req.url.split("?")[0], remoteAddress: req.ip }),
      },
    },
    trustProxy: true,
    bodyLimit: 64 * 1024,
  });

  app.decorate("deps", {
    ...deps,
    mediamtx: deps.mediamtx ?? new MediaMtxClient(deps.env.MEDIAMTX_API_URL),
  });

  await app.register(healthRoutes);
  await app.register(mediamtxRoutes);
  return app;
}
