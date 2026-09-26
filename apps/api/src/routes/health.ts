import type { FastifyInstance } from "fastify";

const VERSION = process.env.TOPCAM_VERSION ?? "0.1.0";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  /** Liveness: o processo responde. */
  app.get("/health", async () => ({ status: "ok" }));

  /** Readiness: dependências obrigatórias (banco e Redis) e estado do servidor de mídia. */
  app.get("/ready", async (_req, reply) => {
    const { pool, redis, mediamtx } = app.deps;
    const checks: Record<string, "ok" | "fail"> = {};
    try {
      await pool.query("SELECT 1");
      checks.database = "ok";
    } catch {
      checks.database = "fail";
    }
    try {
      checks.redis = (await redis.ping()) === "PONG" ? "ok" : "fail";
    } catch {
      checks.redis = "fail";
    }
    try {
      await mediamtx.listPaths();
      checks.mediamtx = "ok";
    } catch {
      checks.mediamtx = "fail";
    }
    const ready = checks.database === "ok" && checks.redis === "ok";
    return reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "not_ready", checks });
  });

  /** Rota pública mínima, exposta pelo gateway. */
  app.get("/api/v1/health", async () => ({
    status: "ok",
    service: "topcam-api",
    version: VERSION,
  }));
}
