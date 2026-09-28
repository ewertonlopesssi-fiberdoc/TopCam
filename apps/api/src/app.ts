import type { Pool } from "@topcam/db";
import { MediaMtxClient } from "@topcam/shared";
import Fastify, { type FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Env } from "./env.js";
import cookie from "@fastify/cookie";
import { HttpError, sendError } from "./lib/http.js";
import { authPlugin } from "./plugins/auth.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { cameraRoutes } from "./routes/cameras.js";
import { healthRoutes } from "./routes/health.js";
import { locationRoutes } from "./routes/locations.js";
import { mediamtxRoutes } from "./routes/mediamtx.js";
import { tenantRoutes } from "./routes/tenants.js";
import { userRoutes } from "./routes/users.js";

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

  await app.register(cookie);
  await authPlugin(app);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return sendError(reply, err);
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: "bad_request", message: (err as Error).message });
    }
    req.log.error({ err }, "erro não tratado");
    return reply
      .code(500)
      .send({ error: "internal_error", message: "Erro interno. Tente novamente." });
  });
  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ error: "not_found", message: "Rota inexistente" }),
  );

  await app.register(healthRoutes);
  await app.register(mediamtxRoutes);
  await app.register(authRoutes);
  await app.register(tenantRoutes);
  await app.register(userRoutes);
  await app.register(locationRoutes);
  await app.register(cameraRoutes);
  await app.register(adminRoutes);
  return app;
}
