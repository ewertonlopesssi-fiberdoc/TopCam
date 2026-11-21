import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { expect, test, type APIRequestContext, type Frame, type Page } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD } from "./helpers";

/**
 * App mobile: ao vivo por WebRTC (sem som, ~1 s) e troca para HLS ao ligar o som (áudio AAC)
 * ou quando o WebRTC falha. Versão web do app contra o laboratório (E2E_APP_URL).
 * Usa o Google Chrome (o Chromium do Playwright não tem H.264 no WebRTC).
 */

const APP = process.env.E2E_APP_URL ?? "http://localhost:8099";
const CODES = ["CAM-001", "CAM-002", "CAM-003", "CAM-004"];
const dc = (...args: string[]) =>
  execFileSync("docker", ["compose", ...args], { encoding: "utf8" }).trim();
const psql = (q: string) =>
  dc("exec", "-T", "postgres", "psql", "-U", "topcam_owner", "-d", "topcam", "-Atq", "-c", q);
mkdirSync("reports/screens", { recursive: true });
test.use({
  channel: "chrome",
  // No celular o player nativo não tem bloqueio de autoplay com som; no Chrome, sim.
  launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
});

async function adminToken(request: APIRequestContext) {
  const r = await request.post("/api/v1/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(r.ok()).toBe(true);
  return (await r.json()).accessToken as string;
}

/** Latência de ponta a ponta (s): lê o relógio desenhado no vídeo pelo transmissor (TX_CLOCK=1). */
async function measure(ctx: Page | Frame, samples = 10): Promise<number> {
  const out: number[] = [];
  for (let i = 0; i < samples; i++) {
    const l = await ctx.evaluate(() => {
      const v = document.querySelector("video") as HTMLVideoElement | null;
      if (!v || !v.videoWidth) return null;
      const c = document.createElement("canvas");
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const g = c.getContext("2d", { willReadFrequently: true })!;
      g.drawImage(v, 0, 0);
      const now = Date.now();
      const bw = Math.floor(v.videoWidth / 25);
      let value = 0;
      for (let b = 0; b < 24; b++) {
        const [r, gg, bl] = g.getImageData(b * bw + bw, 12, 1, 1).data;
        if ((r! + gg! + bl!) / 3 > 128) value += 2 ** b;
      }
      const mod = 2 ** 24;
      return (((((now % mod) - value) % mod) + mod) % mod) / 1000;
    });
    if (l !== null && l < 30) out.push(l);
    await new Promise((r) => setTimeout(r, 400));
  }
  const s = out.sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : NaN;
}

async function rtcFrame(page: Page, n = 0): Promise<Frame | null> {
  const h = await page.locator('iframe[data-testid="webrtc-frame"]').nth(n).elementHandle();
  return (await h?.contentFrame()) ?? null;
}

/** Estado do vídeo dentro do iframe WebRTC. */
async function rtcVideo(page: Page, n = 0) {
  const f = page.locator('iframe[data-testid="webrtc-frame"]').nth(n);
  const h = await f.elementHandle();
  const fr = await h?.contentFrame();
  if (!fr) return null;
  return fr.evaluate(() => {
    const v = document.querySelector("video") as HTMLVideoElement | null;
    return v
      ? { t: v.currentTime, w: v.videoWidth, muted: v.muted, live: v.srcObject !== null }
      : null;
  });
}

test.describe("app mobile: ao vivo WebRTC (web)", () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) > 500, "só na largura de celular");
  test.setTimeout(240_000);

  const email = `apprtc-${Date.now().toString(36)}@alfa.test`;
  let userId = "";
  const cams: Record<string, string> = {};

  test.beforeAll(async ({ request }) => {
    test.setTimeout(240_000);
    const ok = await fetch(APP)
      .then((r) => r.ok)
      .catch(() => false);
    test.skip(!ok, `app web não está no ar em ${APP}`);
    const h = { authorization: `Bearer ${await adminToken(request)}` };
    const tenant = psql("SELECT id FROM tenants WHERE slug = 'empresa-alfa'");
    for (const code of CODES)
      cams[code] = psql(
        `SELECT id FROM cameras WHERE tenant_id = '${tenant}' AND code = '${code}' AND deleted_at IS NULL`,
      );
    const u = await request.post("/api/v1/users", {
      headers: h,
      data: {
        name: "Ao vivo App",
        email,
        role: "viewer",
        tenantId: tenant,
        password: "AoVivoApp9",
      },
    });
    expect(u.ok()).toBe(true);
    userId = (await u.json()).user.id;
    await request.put(`/api/v1/users/${userId}/camera-permissions`, {
      headers: h,
      data: {
        items: CODES.map((c) => ({
          cameraId: cams[c],
          canLive: true,
          canPlayback: false,
          canExport: false,
        })),
      },
    });
    for (const code of CODES) {
      const key = dc(
        "exec",
        "-T",
        "api",
        "node",
        "apps/api/dist/cli.js",
        "camera:show-key",
        "--tenant",
        "empresa-alfa",
        "--code",
        code,
        "--raw",
      );
      execFileSync("docker", ["rm", "-f", `topcam-txrtc-${code}`], { stdio: "ignore" });
      dc(
        "--profile",
        "test",
        "run",
        "-d",
        "--rm",
        "--name",
        `topcam-txrtc-${code}`,
        ...(code === "CAM-001" ? ["-e", "TX_CLOCK=1"] : []),
        "test-transmitter",
        "publish",
        key,
        code,
      );
    }
    const ids = CODES.map((c) => `'${cams[c]}'`).join(",");
    await expect
      .poll(
        () =>
          psql(
            `SELECT count(*) FROM cameras WHERE id IN (${ids}) AND status IN ('ao_vivo', 'gravando') AND audio_codec = 'aac'`,
          ),
        { timeout: 120_000 },
      )
      .toBe(String(CODES.length));
  });

  test.afterAll(async ({ request }) => {
    for (const code of CODES)
      execFileSync("docker", ["rm", "-f", `topcam-txrtc-${code}`], { stdio: "ignore" });
    if (userId) {
      const tok = await adminToken(request);
      await request.delete(`/api/v1/users/${userId}`, {
        headers: { authorization: `Bearer ${tok}` },
      });
    }
  });

  test("WebRTC sem som, HLS com som, volta ao WebRTC, mosaico e queda para HLS", async ({
    page,
  }) => {
    await page.goto(APP);
    await page.getByLabel("E-mail").fill(email);
    await page.getByLabel("Senha", { exact: true }).fill("AoVivoApp9");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("camera-row")).toHaveCount(CODES.length, { timeout: 15_000 });

    // 1) Ao vivo: WebRTC tocando, sem som, com o atraso medido.
    await page.getByRole("button", { name: /CAM-001/ }).click();
    await expect(page.locator('iframe[data-testid="webrtc-frame"]')).toHaveCount(1, {
      timeout: 15_000,
    });
    await expect
      .poll(async () => (await rtcVideo(page))?.t ?? 0, { timeout: 20_000 })
      .toBeGreaterThan(1);
    const v = await rtcVideo(page);
    expect(v?.w).toBe(640);
    expect(v?.muted).toBe(true);
    await expect(page.getByTestId("live-hint")).toContainText("Tempo real");
    await page.waitForTimeout(3000);
    const rtcLat = await measure((await rtcFrame(page))!);
    await page.screenshot({ path: "reports/screens/app-webrtc-aovivo.png" });

    // 2) Ligar o som (áudio AAC): troca para HLS com som.
    await page.getByRole("button", { name: "Ligar som" }).click();
    await expect(page.locator('iframe[data-testid="webrtc-frame"]')).toHaveCount(0);
    await expect(page.getByTestId("live-hint")).toContainText("alguns segundos de atraso");
    // O player do app passa a usar o endereço HLS, com som. Tocar o HLS não é conferido
    // aqui: na versão web o Chrome não reproduz o HLS do expo-video. No celular é o player
    // nativo, já validado na 9.1.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const v = document.querySelector("video");
          return v && /index\.m3u8/.test(v.src) && !v.muted ? "hls-com-som" : "";
        }),
      )
      .toBe("hls-com-som");
    console.log(`latência de ponta a ponta no app (WebRTC): ${rtcLat.toFixed(2)} s`);
    expect(rtcLat).toBeLessThan(2);

    // 3) Desligar o som: volta ao WebRTC.
    await page.getByRole("button", { name: "Desligar som" }).click();
    await expect(page.locator('iframe[data-testid="webrtc-frame"]')).toHaveCount(1);
    await expect
      .poll(async () => (await rtcVideo(page))?.t ?? 0, { timeout: 20_000 })
      .toBeGreaterThan(1);

    // 4) Mosaico de 4: quatro WebRTC tocando.
    await page.goBack();
    await page.getByRole("tab", { name: /Mosaico/ }).click();
    await expect(page.locator('iframe[data-testid="webrtc-frame"]')).toHaveCount(4, {
      timeout: 15_000,
    });
    for (let i = 0; i < 4; i++)
      await expect
        .poll(async () => (await rtcVideo(page, i))?.t ?? 0, { timeout: 20_000 })
        .toBeGreaterThan(1);
    await page.screenshot({ path: "reports/screens/app-webrtc-mosaico.png" });

    // 5) Rede que bloqueia o WebRTC: o app cai para HLS sozinho.
    await page.route("**/whep**", (r) => r.abort());
    await page.getByRole("tab", { name: /Câmeras/ }).click();
    await page.getByRole("button", { name: /CAM-002/ }).click();
    await expect(page.locator('iframe[data-testid="webrtc-frame"]')).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(page.getByTestId("live-hint")).toContainText("alguns segundos de atraso");
    await expect
      .poll(() =>
        page.evaluate(() => /index\.m3u8/.test(document.querySelector("video")?.src ?? "")),
      )
      .toBe(true);
  });
});
