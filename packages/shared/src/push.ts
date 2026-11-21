/**
 * Envio de notificação push pelo serviço da Expo (https://docs.expo.dev/push-notifications/).
 * A Expo entrega pelo Google (FCM) no Android e pela Apple (APNs) no iPhone, com as
 * credenciais de cada app (marca) cadastradas na conta Expo. O servidor só precisa do token
 * do celular e, se a "segurança de push" estiver ligada na conta Expo, do token de acesso.
 *
 * Dois passos:
 *  1. send → devolve um "ticket" por mensagem (aceita ou erro imediato, ex.: token inválido);
 *  2. receipts (≥ 15 min depois) → diz se o Google/Apple aceitou; DeviceNotRegistered =
 *     o app foi desinstalado ou o token mudou → desligar o token.
 */

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push";
/** Limite da Expo por requisição. */
export const PUSH_BATCH = 100;

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: "default" | null;
  priority?: "default" | "normal" | "high";
  channelId?: string;
  ttl?: number;
}

export interface PushTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  /** Ex.: DeviceNotRegistered, MessageTooBig, MessageRateExceeded, InvalidCredentials. */
  error?: string;
}

export interface PushOptions {
  /** Base da API (testes: servidor falso). Padrão: EXPO_PUSH_URL. */
  url?: string;
  accessToken?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Token no formato da Expo: ExponentPushToken[...] ou ExpoPushToken[...]. */
export function isExpoPushToken(t: string): boolean {
  return /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$/.test(t);
}

async function call<T>(path: string, body: unknown, o: PushOptions): Promise<T> {
  const f = o.fetch ?? fetch;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 15_000);
  try {
    const res = await f(`${(o.url || EXPO_PUSH_URL).replace(/\/$/, "")}/${path}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(o.accessToken ? { authorization: `Bearer ${o.accessToken}` } : {}),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const json = (await res.json().catch(() => null)) as {
      data?: T;
      errors?: Array<{ code?: string; message?: string }>;
    } | null;
    if (!res.ok || !json || json.data === undefined) {
      const e = json?.errors?.[0];
      throw new Error(
        `serviço de push respondeu ${res.status}${e ? `: ${e.code ?? ""} ${e.message ?? ""}`.trimEnd() : ""}`,
      );
    }
    return json.data;
  } finally {
    clearTimeout(t);
  }
}

/** Envia (em lotes de 100). Devolve um ticket por mensagem, na mesma ordem. */
export async function sendPush(
  messages: PushMessage[],
  o: PushOptions = {},
): Promise<PushTicket[]> {
  const out: PushTicket[] = [];
  for (let i = 0; i < messages.length; i += PUSH_BATCH) {
    const batch = messages.slice(i, i + PUSH_BATCH);
    try {
      const data = await call<
        Array<{ status: string; id?: string; message?: string; details?: { error?: string } }>
      >("send", batch, o);
      batch.forEach((_, j) => {
        const d = data[j];
        out.push(
          d?.status === "ok"
            ? { status: "ok", id: d.id }
            : {
                status: "error",
                message: (d?.message ?? "sem resposta").slice(0, 300),
                error: d?.details?.error,
              },
        );
      });
    } catch (err) {
      const message = (err as Error).message.slice(0, 300);
      batch.forEach(() => out.push({ status: "error", message }));
    }
  }
  return out;
}

export interface PushReceipt {
  status: "ok" | "error";
  message?: string;
  error?: string;
}

/** Recibos dos tickets (só os que a Expo já tem; os que faltam não vêm). */
export async function pushReceipts(
  ids: string[],
  o: PushOptions = {},
): Promise<Record<string, PushReceipt>> {
  const out: Record<string, PushReceipt> = {};
  for (let i = 0; i < ids.length; i += 300) {
    const data = await call<
      Record<string, { status: string; message?: string; details?: { error?: string } }>
    >("getReceipts", { ids: ids.slice(i, i + 300) }, o);
    for (const [id, r] of Object.entries(data))
      out[id] =
        r.status === "ok"
          ? { status: "ok" }
          : { status: "error", message: r.message?.slice(0, 300), error: r.details?.error };
  }
  return out;
}

/** Erros em que o token não serve mais e deve ser desligado. */
export function deadTokenError(error?: string): boolean {
  return error === "DeviceNotRegistered";
}
