/**
 * Cliente mínimo da API de controle do MediaMTX (v3). A API fica apenas na
 * rede interna dos contêineres; nunca é publicada para fora.
 */

export interface MtxTrack {
  codec: string;
  codecProps?: { width?: number; height?: number; profile?: string; sampleRate?: number };
}

export interface MtxPath {
  name: string;
  confName: string;
  ready: boolean;
  online?: boolean;
  readyTime: string | null;
  source: { type: string; id: string } | null;
  tracks: string[];
  tracks2?: MtxTrack[];
  bytesReceived: number;
  inboundBytes?: number;
}

export interface MtxConn {
  id: string;
  created: string;
  remoteAddr: string;
  state: string;
  path: string;
  bytesReceived: number;
}

export interface MtxPathConf {
  name: string;
  record?: boolean;
  recordPath?: string;
  overridePublisher?: boolean;
  [key: string]: unknown;
}

interface ListResponse<T> {
  itemCount: number;
  pageCount: number;
  items: T[];
}

export class MediaMtxError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export class MediaMtxClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 3000,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new MediaMtxError(`MediaMTX inacessível: ${(err as Error).message}`);
    }
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new MediaMtxError(`MediaMTX ${method} ${path} → ${res.status} ${text}`, res.status);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  private async listAll<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    for (let page = 0; ; page++) {
      const res = await this.request<ListResponse<T>>(
        "GET",
        `${path}?page=${page}&itemsPerPage=500`,
      );
      if (!res) break;
      items.push(...res.items);
      if (page + 1 >= res.pageCount) break;
    }
    return items;
  }

  listPaths(): Promise<MtxPath[]> {
    return this.listAll<MtxPath>("/v3/paths/list");
  }

  getPath(name: string): Promise<MtxPath | null> {
    return this.request<MtxPath>("GET", `/v3/paths/get/${name}`);
  }

  async listPublishers(): Promise<Array<MtxConn & { kind: "rtmpconns" | "rtmpsconns" }>> {
    const out: Array<MtxConn & { kind: "rtmpconns" | "rtmpsconns" }> = [];
    for (const kind of ["rtmpconns", "rtmpsconns"] as const) {
      try {
        const conns = await this.listAll<MtxConn>(`/v3/${kind}/list`);
        for (const c of conns) if (c.state === "publish") out.push({ ...c, kind });
      } catch (err) {
        // RTMPS desabilitado → endpoint responde erro; ignorar apenas nesse caso.
        if (kind === "rtmpconns") throw err;
      }
    }
    return out;
  }

  async kick(kind: "rtmpconns" | "rtmpsconns", id: string): Promise<void> {
    await this.request("POST", `/v3/${kind}/kick/${id}`);
  }

  listPathConfs(): Promise<MtxPathConf[]> {
    return this.listAll<MtxPathConf>("/v3/config/paths/list");
  }

  async addPathConf(name: string, conf: Omit<MtxPathConf, "name">): Promise<void> {
    await this.request("POST", `/v3/config/paths/add/${name}`, conf);
  }

  async patchPathConf(name: string, conf: Omit<MtxPathConf, "name">): Promise<void> {
    await this.request("PATCH", `/v3/config/paths/patch/${name}`, conf);
  }

  async deletePathConf(name: string): Promise<void> {
    await this.request("DELETE", `/v3/config/paths/delete/${name}`);
  }
}
