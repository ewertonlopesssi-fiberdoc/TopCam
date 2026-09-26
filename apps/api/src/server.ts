import { createPool } from "@topcam/db";
import { Redis } from "ioredis";
import { buildApp } from "./app.js";
import { loadEnv } from "./env.js";

const env = loadEnv();
const pool = createPool(env.DATABASE_URL, 20);
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: false });
redis.on("error", (err) => console.error("[redis]", err.message));

const app = await buildApp({ env, pool, redis });

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, "encerrando");
  await app.close();
  await pool.end();
  redis.disconnect();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: env.HOST, port: env.PORT });
