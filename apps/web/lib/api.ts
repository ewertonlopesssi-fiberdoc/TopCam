/**
 * Cliente da API do TopCam (mesma origem, via gateway: /api/v1).
 * - Token de acesso só em memória (nunca em localStorage).
 * - Refresh token em cookie httpOnly; renovação automática em 401.
 */

export interface Me {
  id: string;
  name: string;
  email: string;
  role: string;
  roleLabel: string;
  tenant: { id: string; name: string } | null;
  permissions: string[];
  mustChangePassword: boolean;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  pages: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Array<{ campo: string; erro: string }>,
  ) {
    super(message);
  }
}

let accessToken: string | null = null;
let refreshing: Promise<Me | null> | null = null;
let onSessionLost: (() => void) | null = null;

export function setSessionLostHandler(fn: () => void) {
  onSessionLost = fn;
}

async function parse(res: Response) {
  const text = await res.text();
  let body: Record<string, unknown>;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { message: text };
  }
  if (!res.ok) {
    throw new ApiError(
      res.status,
      String(body.error ?? "error"),
      String(body.message ?? `Erro ${res.status}`),
      body.details as ApiError["details"],
    );
  }
  return body;
}

export async function login(email: string, password: string): Promise<Me> {
  const res = await fetch("/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, client: "web" }),
    credentials: "same-origin",
  });
  const body = await parse(res);
  accessToken = body.accessToken as string;
  return body.user as Me;
}

/** Renova a sessão pelo cookie. Retorna o usuário ou null. Chamadas simultâneas compartilham a mesma renovação. */
export function refresh(): Promise<Me | null> {
  refreshing ??= (async () => {
    try {
      const res = await fetch("/api/v1/auth/refresh", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!res.ok) {
        accessToken = null;
        return null;
      }
      const body = await parse(res);
      accessToken = body.accessToken as string;
      return body.user as Me;
    } catch {
      return null;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

export async function logout(): Promise<void> {
  try {
    await request("POST", "/auth/logout");
  } catch {
    /* sessão já encerrada */
  }
  accessToken = null;
}

export async function request<T = unknown>(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  retry = true,
): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  if (res.status === 401 && retry && !path.startsWith("/auth/")) {
    const me = await refresh();
    if (me) return request<T>(method, path, body, false);
    onSessionLost?.();
  }
  return (await parse(res)) as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body: unknown = {}) => request<T>("POST", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}
