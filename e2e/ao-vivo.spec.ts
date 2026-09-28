import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, changePasswordScreen, login, loginAdmin } from "./helpers";

/**
 * Ao vivo (Fase 3) com transmissões reais.
 *
 * Pré-requisito: as 5 câmeras da Empresa Alfa transmitindo pelo transmissor de teste,
 * a CAM-001 com relógio no vídeo (TX_CLOCK=1) — scripts/accept-phase3.sh prepara isso.
 * Ative com E2E_LIVE=1. Precisa de um navegador com H.264 (Google Chrome:
 * PW_CHROMIUM_PATH=/usr/bin/google-chrome), pois o Chromium do Playwright não tem o codec.
 *
 * A latência é medida lendo, na tela do navegador, o relógio desenhado no vídeo pelo
 * transmissor e comparando com o relógio do navegador (mesma máquina).
 */

test.skip(process.env.E2E_LIVE !== "1", "defina E2E_LIVE=1 com as transmissões de teste no ar");

mkdirSync("reports/screens", { recursive: true });
const RESULTS = "reports/latencia-ao-vivo.json";
const results: Record<string, unknown> = {};

async function apiToken(request: APIRequestContext, email: string, password: string) {
  const r = await request.post("/api/v1/auth/login", { data: { email, password } });
  expect(r.ok()).toBe(true);
  return (await r.json()).accessToken as string;
}

async function alfaCameras(request: APIRequestContext, token: string) {
  const r = await request.get("/api/v1/cameras?pageSize=100", {
    headers: { authorization: `Bearer ${token}` },
  });
  const items = (await r.json()).items as Array<{
    id: string;
    code: string;
    tenantId: string;
    tenantName: string;
    streamKeyPrefix?: string;
  }>;
  return items.filter((c) => c.tenantName === "Empresa Alfa");
}

async function openAlfa(page: Page, mode: "auto" | "webrtc" | "hls", layout = 4) {
  await page.goto("/ao-vivo");
  const client = page.getByLabel("Cliente");
  if (await client.count()) await client.selectOption({ label: "Empresa Alfa" });
  await page.getByLabel("Transmissão").selectOption(mode);
  await page.getByRole("button", { name: `Mosaico com ${layout}`, exact: true }).click();
}

/** Lê o relógio de 24 blocos do topo do vídeo e devolve a latência (s) de ponta a ponta. */
async function measure(page: Page, code: string, samples = 12): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < samples; i++) {
    const l = await page.evaluate((cam) => {
      const v = document.querySelector<HTMLVideoElement>(
        `[data-testid=live-tile][data-camera="${cam}"] video`,
      );
      if (!v || !v.videoWidth) return null;
      const c = document.createElement("canvas");
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const ctx = c.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(v, 0, 0);
      const now = Date.now();
      const bw = Math.floor(v.videoWidth / 25);
      let value = 0;
      for (let b = 0; b < 24; b++) {
        const [r, g, bl] = ctx.getImageData(b * bw + bw, 12, 1, 1).data;
        if ((r! + g! + bl!) / 3 > 128) value += 2 ** b;
      }
      const mod = 2 ** 24;
      const diff = ((((now % mod) - value) % mod) + mod) % mod;
      return diff / 1000;
    }, code);
    if (l !== null && l < 30) out.push(l);
    await page.waitForTimeout(400);
  }
  return out;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : NaN;
};

test.describe("ao vivo", () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1024, "roda na largura de computador");

  test("mosaico com WebRTC e HLS, sem chave no navegador, com latência medida", async ({
    page,
    request,
  }) => {
    await loginAdmin(page);
    const token = await apiToken(request, ADMIN_EMAIL, ADMIN_PASSWORD);
    const cams = await alfaCameras(request, token);
    expect(cams.length).toBeGreaterThanOrEqual(5);

    const urls: string[] = [];
    page.on("request", (r) => urls.push(r.url()));
    const bodies: string[] = [];
    page.on("response", async (r) => {
      if (r.url().includes("/api/v1/live/")) bodies.push(await r.text().catch(() => ""));
    });

    // ---- WebRTC (automático)
    await openAlfa(page, "auto", 4);
    const tiles = page.locator("[data-testid=live-tile]");
    await expect(tiles).toHaveCount(4);
    for (const code of ["CAM-001", "CAM-002", "CAM-003", "CAM-004"])
      await expect(page.locator(`[data-testid=live-tile][data-camera="${code}"]`)).toHaveAttribute(
        "data-state",
        "playing",
        { timeout: 20_000 },
      );
    await expect(tiles.first()).toHaveAttribute("data-tech", "webrtc");
    await page.waitForTimeout(3000);
    const webrtc = await measure(page, "CAM-001");
    expect(webrtc.length).toBeGreaterThan(5);
    results.webrtc = { amostras: webrtc, mediana_s: median(webrtc) };
    await page.screenshot({ path: "reports/screens/computador-ao-vivo-webrtc.png" });

    // ---- mosaico de 9: as 5 câmeras
    await page.getByRole("button", { name: "Mosaico com 9", exact: true }).click();
    await expect(tiles).toHaveCount(5);

    // ---- HLS
    await openAlfa(page, "hls", 4);
    for (const code of ["CAM-001", "CAM-002"])
      await expect(page.locator(`[data-testid=live-tile][data-camera="${code}"]`)).toHaveAttribute(
        "data-state",
        "playing",
        { timeout: 30_000 },
      );
    await expect(tiles.first()).toHaveAttribute("data-tech", "hls");
    await page.waitForTimeout(6000);
    const hls = await measure(page, "CAM-001");
    expect(hls.length).toBeGreaterThan(5);
    results.hls = { amostras: hls, mediana_s: median(hls) };
    await page.screenshot({ path: "reports/screens/computador-ao-vivo-hls.png" });

    // ---- foco em uma câmera (duplo clique) e volta
    await page.locator('[data-testid=live-tile][data-camera="CAM-002"]').dblclick();
    await expect(tiles).toHaveCount(1);
    await page.getByRole("button", { name: "Voltar ao mosaico" }).click();
    await expect(tiles).toHaveCount(4);

    // ---- nada de chave nem caminho interno no navegador
    const prefixes = cams.map((c) => c.streamKeyPrefix).filter(Boolean) as string[];
    expect(prefixes.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect(u).not.toMatch(/\/cam\/[0-9a-f-]{36}/);
      for (const p of prefixes) expect(u).not.toContain(p);
    }
    for (const b of bodies) for (const p of prefixes) expect(b).not.toContain(p);
    expect(urls.some((u) => /\/live\/v1\.[^/]+\/index\.m3u8/.test(u))).toBe(true);

    // ---- endereço adulterado é recusado pelo gateway
    const one = urls.find((u) => /\/live\/v1\.[^/]+\/index\.m3u8/.test(u))!;
    const bad = one.replace(/(\/live\/v1\.[^.]+\.)([^/]+)/, "$1AAAA$2");
    expect((await request.get(bad)).status()).toBe(403);

    results.medidoEm = new Date().toISOString();
    results.navegador = await page.evaluate(() => navigator.userAgent);
    writeFileSync(RESULTS, JSON.stringify(results, null, 2));
    console.log(
      `latência de ponta a ponta (mediana): WebRTC ${median(webrtc).toFixed(2)} s · HLS ${median(hls).toFixed(2)} s`,
    );
  });

  test("visualizador vê só a câmera liberada e perde o vídeo quando a permissão é retirada", async ({
    page,
    request,
  }) => {
    const token = await apiToken(request, ADMIN_EMAIL, ADMIN_PASSWORD);
    const auth = { headers: { authorization: `Bearer ${token}` } };
    const cams = await alfaCameras(request, token);
    const cam2 = cams.find((c) => c.code === "CAM-002")!;
    const stamp = Date.now().toString().slice(-6);
    const email = `vigia${stamp}@e2e.test`;
    const created = await request.post("/api/v1/users", {
      ...auth,
      data: { name: `Vigia ${stamp}`, email, role: "viewer", tenantId: cam2.tenantId },
    });
    expect(created.status()).toBe(201);
    const { user, temporaryPassword } = await created.json();
    await request.put(`/api/v1/users/${user.id}/camera-permissions`, {
      ...auth,
      data: { items: [{ cameraId: cam2.id, canLive: true }] },
    });

    await login(page, email, temporaryPassword);
    await changePasswordScreen(page, temporaryPassword, `Portaria${stamp}Segura`);
    await page.goto("/ao-vivo");
    await page.getByLabel("Transmissão").selectOption("webrtc");
    const tiles = page.locator("[data-testid=live-tile]");
    await expect(tiles).toHaveCount(1);
    const tile = page.locator('[data-testid=live-tile][data-camera="CAM-002"]');
    await expect(tile).toHaveAttribute("data-state", "playing", { timeout: 20_000 });
    await expect(
      page.getByRole("navigation", { name: "Câmeras por local" }).getByRole("button"),
    ).toHaveCount(3); // empresa, local e a câmera

    // Uma conexão WebRTC aberta "por fora" do painel (como faria um cliente modificado):
    // só o worker pode encerrá-la, pois a mídia não passa mais pelo gateway.
    const viewerApi = await apiToken(request, email, `Portaria${stamp}Segura`);
    const live = await (
      await request.post(`/api/v1/cameras/${cam2.id}/live`, {
        headers: { authorization: `Bearer ${viewerApi}` },
      })
    ).json();
    await page.evaluate(async (whep: string) => {
      const pc = new RTCPeerConnection();
      pc.addTransceiver("video", { direction: "recvonly" });
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise((r) => setTimeout(r, 1000));
      const res = await fetch(whep, {
        method: "POST",
        headers: { "content-type": "application/sdp" },
        body: pc.localDescription!.sdp,
      });
      await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
      (window as unknown as { rawPc: RTCPeerConnection }).rawPc = pc;
    }, live.whep);
    const rawState = () =>
      page.evaluate(
        () => (window as unknown as { rawPc: RTCPeerConnection }).rawPc.connectionState,
      );
    await expect.poll(rawState, { timeout: 15_000 }).toBe("connected");

    // Retira a permissão: o worker encerra as sessões WebRTC e o novo endereço é negado.
    const t0 = Date.now();
    await request.put(`/api/v1/users/${user.id}/camera-permissions`, {
      ...auth,
      data: { items: [] },
    });
    await expect
      .poll(
        async () => ((await tile.count()) ? await tile.getAttribute("data-state") : "removida"),
        {
          timeout: 30_000,
          intervals: [500],
        },
      )
      .not.toBe("playing");
    results.revogacao_painel_s = (Date.now() - t0) / 1000;
    await expect
      .poll(rawState, { timeout: 30_000, intervals: [500] })
      .toMatch(/disconnected|failed|closed/);
    results.revogacao_webrtc_s = (Date.now() - t0) / 1000;
    console.log(
      `após retirar a permissão: painel parou em ${results.revogacao_painel_s} s; conexão WebRTC externa encerrada em ${results.revogacao_webrtc_s} s`,
    );
    const previous = existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, "utf8")) : {};
    writeFileSync(RESULTS, JSON.stringify({ ...previous, ...results }, null, 2));
    await request.delete(`/api/v1/users/${user.id}`, auth);
  });
});
