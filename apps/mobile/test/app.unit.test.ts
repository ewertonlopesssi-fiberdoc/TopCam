import { describe, expect, it } from "vitest";
import { ApiClient, ApiError, type KeyStore } from "../src/lib/api";
import { buildTree, pages, passwordProblem, statusOf, type Camera } from "../src/lib/cameras";

/** App mobile: cliente da API (sessão, renovação) e regras das telas, sem React Native. */

function memStore(init: Record<string, string> = {}): KeyStore & { data: Record<string, string> } {
  const data = { ...init };
  return {
    data,
    get: async (k) => data[k] ?? null,
    set: async (k, v) => {
      data[k] = v;
    },
    del: async (k) => {
      delete data[k];
    },
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const USER = { id: "u1", name: "Ana", email: "a@x", role: "viewer", mustChangePassword: false };

describe("cliente da API", () => {
  it("login como mobile guarda o refresh token e usa o token de acesso", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const store = memStore();
    const api = new ApiClient("https://topcam.test", store, async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/auth/login"))
        return json(200, { accessToken: "A1", refreshToken: "R1", user: USER });
      return json(200, { items: [] });
    });
    const u = await api.login("a@x", "Senha123");
    expect(u.name).toBe("Ana");
    expect(JSON.parse(String(calls[0]!.init!.body))).toMatchObject({ client: "mobile" });
    expect(store.data["topcam.refreshToken"]).toBe("R1");
    await api.get("/api/v1/cameras");
    expect((calls[1]!.init!.headers as Record<string, string>).authorization).toBe("Bearer A1");
  });

  it("401: renova uma vez para pedidos em paralelo e repete os pedidos", async () => {
    let refreshes = 0;
    let token = "A0";
    const store = memStore({ "topcam.refreshToken": "R0" });
    const api = new ApiClient("https://t", store, async (url, init) => {
      if (url.endsWith("/auth/refresh")) {
        refreshes++;
        await new Promise((r) => setTimeout(r, 20));
        token = "A2";
        return json(200, { accessToken: "A2", refreshToken: "R2", user: USER });
      }
      const auth = (init!.headers as Record<string, string>).authorization;
      return auth === `Bearer ${token}` && token === "A2" ? json(200, { ok: 1 }) : json(401, {});
    });
    const r = await Promise.all([api.get("/a"), api.get("/b"), api.get("/c")]);
    expect(r).toEqual([{ ok: 1 }, { ok: 1 }, { ok: 1 }]);
    expect(refreshes).toBe(1);
    expect(store.data["topcam.refreshToken"]).toBe("R2");
  });

  it("refresh recusado: sessão perdida, token apagado", async () => {
    const store = memStore({ "topcam.refreshToken": "R0" });
    let lost = 0;
    const api = new ApiClient("https://t", store, async (url) =>
      url.endsWith("/auth/refresh") ? json(401, {}) : json(401, {}),
    );
    api.onSessionLost = () => lost++;
    await expect(api.get("/x")).rejects.toMatchObject({ status: 401 });
    expect(lost).toBe(1);
    expect(store.data["topcam.refreshToken"]).toBeUndefined();
  });

  it("mensagens de erro em português (da API, sem rede, servidor fora)", async () => {
    const api = new ApiClient("https://t", memStore(), async (url) => {
      if (url.endsWith("/bad")) return json(400, { error: "x", message: "Senha atual incorreta." });
      if (url.endsWith("/down")) return json(502, {});
      throw new TypeError("Network request failed");
    });
    await expect(api.post("/bad")).rejects.toThrow("Senha atual incorreta.");
    await expect(api.get("/down")).rejects.toThrow(/servidor está com problemas/);
    const e = (await api.get("/offline").catch((x: unknown) => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.message).toMatch(/Sem conexão/);
  });

  it("endereço do ao vivo relativo vira absoluto no servidor da marca", () => {
    const api = new ApiClient("https://topcam.suportinet.com.br", memStore());
    expect(api.url("/live/tok/index.m3u8?cookieCheck=1")).toBe(
      "https://topcam.suportinet.com.br/live/tok/index.m3u8?cookieCheck=1",
    );
  });
});

describe("telas", () => {
  const cam = (p: Partial<Camera>): Camera => ({
    id: Math.random().toString(36),
    code: "CAM-001",
    name: "Câmera",
    tenantId: "t1",
    tenantName: "Condomínio Sol",
    locationId: "l1",
    locationName: "Matriz",
    groupId: null,
    groupName: null,
    status: "ao_vivo",
    lastVideoAt: null,
    recordingEnabled: false,
    enabled: true,
    ...p,
  });

  it("agrupa por local e grupo; 'Sem grupo' por último; nome do cliente só com mais de um", () => {
    const tree = buildTree([
      cam({ name: "Portão", groupId: "g1", groupName: "Externo" }),
      cam({ name: "Hall", groupId: null }),
      cam({ name: "Garagem", groupId: "g1", groupName: "Externo" }),
      cam({ name: "Piscina", locationId: "l2", locationName: "Área de lazer" }),
    ]);
    expect(tree.map((s) => s.title)).toEqual(["Área de lazer", "Matriz"]);
    expect(tree[1]!.groups.map((g) => g.title)).toEqual(["Externo", "Sem grupo"]);
    expect(tree[1]!.groups[0]!.cameras.map((c) => c.name)).toEqual(["Garagem", "Portão"]);
    const two = buildTree([cam({}), cam({ tenantId: "t2", tenantName: "Empresa Alfa" })]);
    expect(two.map((s) => s.title).sort()).toEqual([
      "Condomínio Sol › Matriz",
      "Empresa Alfa › Matriz",
    ]);
  });

  it("mosaico em páginas de 4", () => {
    expect(pages([1, 2, 3, 4, 5, 6])).toEqual([
      [1, 2, 3, 4],
      [5, 6],
    ]);
  });

  it("status e regras de senha iguais às da API", () => {
    expect(statusOf("offline").label).toBe("Sem sinal");
    expect(statusOf("gravando").tone).toBe("green");
    expect(passwordProblem("abc")).toMatch(/8 caracteres/);
    expect(passwordProblem("abcdefgh1")).toMatch(/maiúscula/);
    expect(passwordProblem("Abcdefgh")).toMatch(/número/);
    expect(passwordProblem("Abcdefg1")).toBeNull();
  });
});

describe("gravações: datas de Brasília e trechos", () => {
  it("dia, início do dia e relógio no horário de Brasília", async () => {
    const { dayOf, dayStart, clock, whenLabel, addDays } = await import("../src/lib/time");
    // 01/10 23:30 em Brasília = 02/10 02:30 UTC
    const t = Date.parse("2026-10-02T02:30:00Z");
    expect(dayOf(t)).toBe("2026-10-01");
    expect(dayStart("2026-10-01")).toBe(Date.parse("2026-10-01T03:00:00Z"));
    expect(clock(t)).toBe("23:30:00");
    expect(whenLabel(t, t + 3600_000)).toBe("ontem 23:30");
    expect(whenLabel(t, t + 60_000)).toBe("hoje 23:30");
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
  });

  it("blocos contínuos e trecho a reproduzir (até 15 min, pula lacuna)", async () => {
    const { toSpans, chunkFrom } = await import("../src/lib/time");
    const iso = (s: number) => new Date(1_000_000_000_000 + s * 1000).toISOString();
    const spans = toSpans([
      { startedAt: iso(0), endedAt: iso(60) },
      { startedAt: iso(61), endedAt: iso(120) }, // encosta (1 s): mesmo bloco
      { startedAt: iso(300), endedAt: iso(2400) }, // depois de uma lacuna
    ]);
    expect(spans.length).toBe(2);
    const base = 1_000_000_000_000;
    expect(chunkFrom(spans, base + 30_000)).toEqual({ start: base + 30_000, end: base + 120_000 });
    // Na lacuna: vai para o próximo bloco; no máximo 900 s.
    const c = chunkFrom(spans, base + 200_000)!;
    expect(c.start).toBe(base + 300_005);
    expect(c.end - c.start).toBe(900_000);
    expect(chunkFrom(spans, base + 3_000_000)).toBeNull();
  });
});
