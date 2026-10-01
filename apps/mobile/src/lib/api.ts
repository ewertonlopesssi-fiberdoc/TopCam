/**
 * Cliente da API do TopCam para o app. Sem dependência de React Native (testável no Node).
 *
 * - Login como "mobile": a API devolve o refresh token no corpo (não em cookie).
 * - O refresh token fica no armazenamento seguro do celular; o token de acesso (15 min)
 *   só na memória.
 * - Resposta 401: renova uma única vez (pedidos em paralelo esperam a mesma renovação)
 *   e repete o pedido. Se a renovação falhar, a sessão acabou.
 */

export interface KeyStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  roleLabel: string;
  tenant: { id: string; name: string } | null;
  permissions: string[];
  mustChangePassword: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

const REFRESH_KEY = "topcam.refreshToken";
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class ApiClient {
  private accessToken: string | null = null;
  private refreshing: Promise<User | null> | null = null;
  onSessionLost: (() => void) | null = null;

  constructor(
    readonly baseUrl: string,
    private readonly store: KeyStore,
    private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i),
  ) {}

  /** Endereço absoluto a partir de um caminho da API (ex.: /live/<token>/index.m3u8). */
  url(path: string): string {
    return /^https?:\/\//.test(path) ? path : `${this.baseUrl}${path}`;
  }

  private async raw(method: string, path: string, body?: unknown, auth = true): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (auth && this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;
    try {
      return await this.fetchImpl(this.url(path), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, "Sem conexão com o servidor. Verifique a internet e tente de novo.");
    }
  }

  private static async fail(r: Response): Promise<never> {
    let message = `Erro ${r.status}`;
    let code: string | undefined;
    try {
      const j = (await r.json()) as { message?: string; error?: string };
      if (j.message) message = j.message;
      code = j.error;
    } catch {
      // resposta sem JSON
    }
    if (r.status >= 500) message = "O servidor está com problemas. Tente de novo em instantes.";
    throw new ApiError(r.status, message, code);
  }

  private async session(r: Response): Promise<User> {
    if (!r.ok) await ApiClient.fail(r);
    const j = (await r.json()) as { accessToken: string; refreshToken?: string; user: User };
    this.accessToken = j.accessToken;
    if (j.refreshToken) await this.store.set(REFRESH_KEY, j.refreshToken);
    return j.user;
  }

  async login(email: string, password: string): Promise<User> {
    const r = await this.raw(
      "POST",
      "/api/v1/auth/login",
      { email, password, client: "mobile" },
      false,
    );
    return this.session(r);
  }

  /** Renova a sessão com o refresh token guardado (abrir o app, token vencido). */
  restore(): Promise<User | null> {
    if (!this.refreshing)
      this.refreshing = (async () => {
        const token = await this.store.get(REFRESH_KEY);
        if (!token) return null;
        const r = await this.raw("POST", "/api/v1/auth/refresh", { refreshToken: token }, false);
        if (r.status === 401) {
          await this.forget();
          return null;
        }
        return this.session(r);
      })().finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let r = await this.raw(method, path, body);
    if (r.status === 401) {
      const user = await this.restore().catch(() => null);
      if (!user) {
        this.onSessionLost?.();
        throw new ApiError(401, "Sessão expirada. Entre novamente.");
      }
      r = await this.raw(method, path, body);
    }
    if (!r.ok) await ApiClient.fail(r);
    return (r.status === 204 ? undefined : await r.json()) as T;
  }

  get<T>(path: string) {
    return this.request<T>("GET", path);
  }
  post<T>(path: string, body: unknown = {}) {
    return this.request<T>("POST", path, body);
  }

  async logout(): Promise<void> {
    if (this.accessToken) await this.raw("POST", "/api/v1/auth/logout", {}).catch(() => undefined);
    await this.forget();
  }

  private async forget() {
    this.accessToken = null;
    await this.store.del(REFRESH_KEY);
  }
}
