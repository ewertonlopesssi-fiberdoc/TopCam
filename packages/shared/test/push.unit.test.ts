import { describe, expect, it } from "vitest";
import {
  deadTokenError,
  isExpoPushToken,
  pushReceipts,
  sendPush,
  type PushMessage,
} from "../src/push.js";

/** Cliente do serviço de push da Expo: lotes, erros e recibos (fetch falso). */

function fakeFetch(
  handler: (url: string, body: unknown, headers: Record<string, string>) => Response,
) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const f = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, body });
    return handler(url, body, init.headers as Record<string, string>);
  }) as unknown as typeof fetch;
  return { f, calls };
}
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const msg = (i: number): PushMessage => ({
  to: `ExponentPushToken[t${i}xxxxxxxx]`,
  title: "a",
  body: "b",
});

describe("push (Expo)", () => {
  it("formato do token", () => {
    expect(isExpoPushToken("ExponentPushToken[AbC_123-xyzxyz]")).toBe(true);
    expect(isExpoPushToken("ExpoPushToken[AbC_123-xyzxyz]")).toBe(true);
    expect(isExpoPushToken("ExponentPushToken[]")).toBe(false);
    expect(isExpoPushToken("fcm:abcdef")).toBe(false);
    expect(isExpoPushToken("ExponentPushToken[a b]")).toBe(false);
  });

  it("envia em lotes de 100, com o token de acesso, e devolve um ticket por mensagem", async () => {
    const { f, calls } = fakeFetch((_u, body, h) => {
      expect(h.authorization).toBe("Bearer segredo");
      return json({
        data: (body as PushMessage[]).map((m) =>
          m.to.includes("t7x")
            ? {
                status: "error",
                message: "não registrado",
                details: { error: "DeviceNotRegistered" },
              }
            : { status: "ok", id: `id-${m.to}` },
        ),
      });
    });
    const msgs = Array.from({ length: 150 }, (_, i) => msg(i));
    const t = await sendPush(msgs, { url: "http://x/", accessToken: "segredo", fetch: f });
    expect(calls.map((c) => c.url)).toEqual(["http://x/send", "http://x/send"]);
    expect((calls[0]!.body as unknown[]).length).toBe(100);
    expect((calls[1]!.body as unknown[]).length).toBe(50);
    expect(t.length).toBe(150);
    expect(t[0]).toEqual({ status: "ok", id: `id-${msgs[0]!.to}` });
    expect(t[7]).toMatchObject({ status: "error", error: "DeviceNotRegistered" });
    expect(deadTokenError(t[7]!.error)).toBe(true);
    expect(deadTokenError("MessageRateExceeded")).toBe(false);
  });

  it("serviço fora do ar: todas as mensagens do lote ficam com erro (sem exceção)", async () => {
    const { f } = fakeFetch(() =>
      json({ errors: [{ code: "PUSH_TOO_MANY", message: "devagar" }] }, 429),
    );
    const t = await sendPush([msg(1), msg(2)], { fetch: f });
    expect(t).toHaveLength(2);
    expect(
      t.every((x) => x.status === "error" && /429: PUSH_TOO_MANY devagar/.test(x.message!)),
    ).toBe(true);
  });

  it("recibos", async () => {
    const { f, calls } = fakeFetch(() =>
      json({
        data: {
          a: { status: "ok" },
          b: { status: "error", message: "x", details: { error: "DeviceNotRegistered" } },
        },
      }),
    );
    const r = await pushReceipts(["a", "b", "c"], { fetch: f });
    expect(calls[0]!.url).toBe("https://exp.host/--/api/v2/push/getReceipts");
    expect(calls[0]!.body).toEqual({ ids: ["a", "b", "c"] });
    expect(r).toEqual({
      a: { status: "ok" },
      b: { status: "error", message: "x", error: "DeviceNotRegistered" },
    });
  });
});
