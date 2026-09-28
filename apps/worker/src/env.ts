import { hostname } from "node:os";
import { z } from "zod";

const schema = z.object({
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  MEDIAMTX_API_URL: z.string().url().default("http://mediamtx:9997"),
  /** Endereço RTSP interno do MediaMTX, usado só para validar o stream (ffprobe). */
  MEDIAMTX_RTSP_URL: z.string().default("rtsp://mediamtx:8554"),
  /** Endereço RTSP do MediaMTX visto de dentro dele mesmo (fonte dos relays cam/<id>). */
  MEDIAMTX_SELF_RTSP_URL: z.string().default("rtsp://127.0.0.1:8554"),
  MEDIA_READ_USER: z.string().min(3).default("topcam-internal"),
  MEDIA_READ_PASSWORD: z.string().min(24),
  STREAM_KEY_ENC_KEY: z.string().min(40),
  /** Mesmo segredo da API: o worker confere os tokens do ao vivo das sessões WebRTC. */
  JWT_SECRET: z.string().min(32),
  /** Intervalo da conferência das sessões WebRTC abertas (revogação de acesso). */
  LIVE_GUARD_INTERVAL_S: z.coerce.number().positive().default(10),
  /** Diretório de gravações como o MediaMTX o enxerga (volume compartilhado). */
  RECORDINGS_PATH: z.string().default("/recordings"),
  POLL_INTERVAL_S: z.coerce.number().positive().default(5),
  OFFLINE_AFTER_S: z.coerce.number().positive().default(10),
  CONNECT_TIMEOUT_S: z.coerce.number().positive().default(30),
  RECONCILE_INTERVAL_S: z.coerce.number().positive().default(60),
  PROBE_TIMEOUT_S: z.coerce.number().positive().default(15),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  WORKER_ID: z.string().default(`worker-${hostname()}`),
});

export type WorkerEnv = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Configuração inválida: ${issues}`);
  }
  return parsed.data;
}
