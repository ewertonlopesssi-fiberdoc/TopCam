import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.string().default("production"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  /** Segredo compartilhado com o MediaMTX para as rotas /internal/*. */
  MEDIA_HOOK_SECRET: z.string().min(24),
  MEDIAMTX_API_URL: z.string().url().default("http://mediamtx:9997"),
  /** Credencial interna de leitura (usada pelo worker para validar o stream). */
  MEDIA_READ_USER: z.string().min(3).default("topcam-internal"),
  MEDIA_READ_PASSWORD: z.string().min(24),
  STREAM_KEY_ENC_KEY: z.string().min(40),
  PUBLIC_HOST: z.string().default("localhost"),
  RTMP_PUBLIC_PORT: z.coerce.number().int().positive().default(1935),
  /** Janela em que uma câmera com vídeo recente é considerada publicando (recusa duplicadas). */
  PUBLISH_ACTIVE_WINDOW_S: z.coerce.number().positive().default(12),
  /** Janela de supressão de eventos repetidos de chave inválida (segundos). */
  AUTH_REJECT_EVENT_WINDOW_S: z.coerce.number().int().positive().default(60),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Configuração inválida: ${issues}`);
  }
  return parsed.data;
}
