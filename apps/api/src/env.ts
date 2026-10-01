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
  /** Token (Bearer) com que o gateway lê cam/<id> no MediaMTX para o ao vivo. */
  MEDIA_GATEWAY_TOKEN: z.string().min(24),
  STREAM_KEY_ENC_KEY: z.string().min(40),
  PUBLIC_HOST: z.string().default("localhost"),
  /** Endereço do painel usado nos e-mails de acesso (ex.: http://172.31.141.20). */
  PANEL_URL: z.string().optional(),
  /** Raiz das gravações como o MediaMTX a vê (os hooks informam caminhos absolutos). */
  RECORDINGS_PATH: z.string().default("/recordings"),
  RTMP_PUBLIC_PORT: z.coerce.number().int().positive().default(1935),
  /** Porta pública do receptor de eventos (e-mail das câmeras com detecção própria). */
  EVENTS_SMTP_PUBLIC_PORT: z.coerce.number().int().positive().default(2525),
  /** Janela em que uma câmera com vídeo recente é considerada publicando (recusa duplicadas). */
  PUBLISH_ACTIVE_WINDOW_S: z.coerce.number().positive().default(12),
  /** Janela de supressão de eventos repetidos de chave inválida (segundos). */
  AUTH_REJECT_EVENT_WINDOW_S: z.coerce.number().int().positive().default(60),

  // ---- autenticação do painel/app (Fase 2)
  /** Segredo HMAC dos tokens de acesso (JWT HS256). */
  JWT_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL_S: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_H: z.coerce.number().int().positive().default(720),
  /** Cookie do refresh token só por HTTPS (scripts/https.sh liga junto com o HTTPS). */
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_WINDOW_S: z.coerce.number().int().positive().default(900),

  // ---- limites (Fase 8)
  /** Requisições por minuto por IP na API (0 desliga). Redes confiáveis ficam de fora. */
  RATE_LIMIT_API_PER_MIN: z.coerce.number().int().min(0).default(1200),
  /** Chaves de câmera erradas por IP em 10 min antes do bloqueio temporário. */
  PUBLISH_BADKEY_MAX: z.coerce.number().int().positive().default(20),
  /** Duração do bloqueio de quem erra chave de câmera (segundos). */
  PUBLISH_BADKEY_BLOCK_S: z.coerce.number().int().positive().default(1800),

  /** Cópias locais do backup (montadas só leitura; download pelo painel). */
  BACKUP_DIR: z.string().default("/backups"),

  // ---- ao vivo (Fase 3)
  /** Validade do endereço temporário do ao vivo. A sessão e a permissão são reconferidas a cada acesso. */
  LIVE_TOKEN_TTL_S: z.coerce.number().int().min(60).default(7200),
  /** Cache da validação do token no gateway (segundos). Revogações valem em até este tempo. */
  LIVE_AUTH_CACHE_S: z.coerce.number().int().min(0).default(5),

  // ---- reprodução e exportação (Fase 5)
  /** Servidor de reprodução interno do MediaMTX. */
  MEDIAMTX_PLAYBACK_URL: z.string().url().default("http://mediamtx:9996"),
  /** Maior trecho exportável de uma vez (segundos). */
  EXPORT_MAX_S: z.coerce.number().int().positive().default(3600),
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
