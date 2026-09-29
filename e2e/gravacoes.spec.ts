import { execFileSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  changePasswordScreen,
  login,
  loginAdmin,
  noHorizontalOverflow,
} from "./helpers";

/**
 * Gravações (Fase 5) com gravação real.
 *
 * Pré-requisito: CAM-001 da Empresa Alfa com gravação marcada, transmitindo pelo
 * transmissor de teste com relógio no vídeo (TX_CLOCK=1) há pelo menos 6 minutos —
 * scripts/accept-phase5.sh prepara isso. Ative com E2E_RECORDING=1 e um navegador com
 * H.264 (PW_CHROMIUM_PATH=/usr/bin/google-chrome).
 *
 * A precisão da reprodução é medida comparando o horário mostrado pelo player com o
 * relógio desenhado no vídeo pelo transmissor no momento em que o quadro foi gerado.
 */

mkdirSync("reports/screens", { recursive: true });

async function apiToken(request: APIRequestContext, email: string, password: string) {
  const r = await request.post("/api/v1/auth/login", { data: { email, password } });
  expect(r.ok()).toBe(true);
  return (await r.json()).accessToken as string;
}

async function cam001(request: APIRequestContext, token: string) {
  const r = await request.get("/api/v1/cameras?pageSize=100", {
    headers: { authorization: `Bearer ${token}` },
  });
  const items = (await r.json()).items as Array<{
    id: string;
    code: string;
    tenantId: string;
    tenantName: string;
  }>;
  return items.find((c) => c.tenantName === "Empresa Alfa" && c.code === "CAM-001")!;
}

/** Diferença (s) entre o horário do player e o relógio desenhado no quadro exibido. */
async function offsets(page: Page, samples = 6): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < samples; i++) {
    const d = await page.evaluate(() => {
      const v = document.querySelector<HTMLVideoElement>("[data-testid=recording-player] video");
      const clock = document.querySelector<HTMLElement>("[data-testid=player-clock]");
      if (!v || !v.videoWidth || !clock) return null;
      const c = document.createElement("canvas");
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const ctx = c.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(v, 0, 0);
      const shown = Number(clock.dataset.ms);
      const bw = Math.floor(v.videoWidth / 25);
      let value = 0;
      for (let b = 0; b < 24; b++) {
        const [r, g, bl] = ctx.getImageData(b * bw + bw, 12, 1, 1).data;
        if ((r! + g! + bl!) / 3 > 128) value += 2 ** b;
      }
      const mod = 2 ** 24;
      let diff = ((((shown % mod) - value) % mod) + mod) % mod;
      if (diff > mod / 2) diff -= mod;
      return diff / 1000;
    });
    if (d !== null) out.push(d);
    await page.waitForTimeout(300);
  }
  return out;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : NaN;
};

const zoned = (ms: number) =>
  new Date(ms)
    .toLocaleString("sv-SE", { timeZone: "America/Sao_Paulo", hour12: false })
    .replace(" ", "T");

async function openAlfa(page: Page) {
  await page.goto("/gravacoes");
  const client = page.getByLabel("Cliente");
  if (await client.count()) await client.selectOption({ label: "Empresa Alfa" });
}

const playerClock = (page: Page) =>
  page
    .locator("[data-testid=player-clock]")
    .getAttribute("data-ms")
    .then((v) => Number(v));

test.describe("gravações — layout", () => {
  test("a tela abre sem rolar na horizontal", async ({ page }) => {
    await loginAdmin(page);
    await openAlfa(page);
    await expect(page.getByRole("heading", { name: "Gravações" })).toBeAttached();
    await page.waitForLoadState("networkidle");
    await noHorizontalOverflow(page);
    await page.screenshot({ path: `reports/screens/gravacoes-${test.info().project.name}.png` });
  });
});

test.describe("gravações — reprodução real", () => {
  test.skip(process.env.E2E_RECORDING !== "1", "defina E2E_RECORDING=1 com a CAM-001 gravando");
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1024, "roda na largura de computador");
  test.setTimeout(180_000);

  test("admin reproduz com precisão, busca um horário, muda a velocidade e exporta MP4", async ({
    page,
    request,
  }) => {
    await loginAdmin(page);
    await openAlfa(page);
    await expect(page.getByText("CAM-001 ·").first()).toBeVisible();
    await expect(page.locator("[data-testid=calendar] [data-has-recording]").first()).toBeVisible();
    await expect(page.locator("[data-testid=timeline-span]").first()).toBeAttached();

    // ---- reproduzir desde o início do dia (primeiro bloco)
    await page.getByRole("button", { name: "Reproduzir" }).first().click();
    const player = page.locator("[data-testid=recording-player]");
    await expect(player).toHaveAttribute("data-state", "playing", { timeout: 30_000 });
    await page.waitForTimeout(2000);
    const o1 = await offsets(page);
    console.log(`reprodução: diferença player × relógio do vídeo (s): ${o1.join(", ")}`);
    expect(o1.length).toBeGreaterThan(2);
    expect(Math.abs(median(o1))).toBeLessThan(3);

    // ---- Buscar um horário: 4 min atrás
    const target = Date.now() - 4 * 60_000;
    await page.getByLabel("Início").fill(zoned(target));
    await page.getByRole("button", { name: "Buscar" }).click();
    await expect
      .poll(async () => Math.abs((await playerClock(page)) - target), { timeout: 20_000 })
      .toBeLessThan(5_000);
    await expect(player).toHaveAttribute("data-state", "playing", { timeout: 20_000 });
    await page.waitForTimeout(1500);
    const o2 = await offsets(page);
    console.log(`após Buscar: diferença (s): ${o2.join(", ")}`);
    expect(Math.abs(median(o2))).toBeLessThan(3);
    await expect(page.locator("[data-testid=timeline-cursor]")).toBeAttached();

    // ---- lacuna: a reprodução salta para depois dela sozinha
    const token0 = await apiToken(request, ADMIN_EMAIL, ADMIN_PASSWORD);
    const cam = await cam001(request, token0);
    const tl = await (
      await request.get(
        `/api/v1/cameras/${cam.id}/recordings?from=${new Date(Date.now() - 6 * 3600_000).toISOString()}`,
        { headers: { authorization: `Bearer ${token0}` } },
      )
    ).json();
    const gap = (tl.gaps as Array<{ from: string; to: string; seconds: number }>).at(-1);
    if (gap) {
      const gFrom = Date.parse(gap.from);
      const gTo = Date.parse(gap.to);
      await page.getByLabel("Início").fill(zoned(gFrom - 8_000));
      await page.getByRole("button", { name: "Buscar" }).click();
      await expect
        .poll(() => playerClock(page), { timeout: 40_000, intervals: [500] })
        .toBeGreaterThan(gTo);
      const after = await playerClock(page);
      console.log(
        `lacuna de ${gap.seconds} s saltada: player foi de ${new Date(gFrom).toISOString()} para ${new Date(after).toISOString()}`,
      );
      expect(after - gTo).toBeLessThan(15_000);
      await expect(player).toHaveAttribute("data-state", "playing", { timeout: 20_000 });
    } else console.log("sem lacuna nas últimas 6 h: salto de lacuna não verificado");

    // ---- velocidade 4x: em ~6 s de relógio real devem passar ~24 s de vídeo
    await page.getByRole("button", { name: "4x", exact: true }).click();
    await page.waitForTimeout(1000);
    const a = await playerClock(page);
    const t0 = Date.now();
    await page.waitForTimeout(6000);
    const speed = ((await playerClock(page)) - a) / (Date.now() - t0);
    console.log(`velocidade medida em 4x: ${speed.toFixed(2)}x`);
    expect(speed).toBeGreaterThan(2.5);
    await page.getByRole("button", { name: "1x", exact: true }).click();
    await page.screenshot({ path: "reports/screens/gravacoes-reproducao.png" });

    // ---- exportar 1 minuto: download MP4 com nome padrão, e auditoria
    const start = Date.now() - 3 * 60_000;
    await page.getByLabel("Início").fill(zoned(start));
    await page.getByLabel("Fim").fill(zoned(start + 60_000));
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 60_000 }),
      page.getByRole("button", { name: "Baixar MP4" }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(
      /^CAM-001_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_1min\.mp4$/,
    );
    const file = `reports/e2e-output/${download.suggestedFilename()}`;
    await download.saveAs(file);
    expect(statSync(file).size).toBeGreaterThan(50_000);
    const probe = execFileSync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_name",
      "-of",
      "compact",
      file,
    ]).toString();
    console.log(`arquivo exportado: ${probe.replace(/\n/g, " ")}`);
    expect(probe).toContain("codec_name=h264");
    const dur = Number(/duration=([\d.]+)/.exec(probe)![1]);
    expect(dur).toBeGreaterThan(55);
    expect(dur).toBeLessThan(66);

    const token = await apiToken(request, ADMIN_EMAIL, ADMIN_PASSWORD);
    const audit = await (
      await request.get("/api/v1/audit-logs?action=camera.export&pageSize=5", {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json();
    const actions = (audit.items as Array<{ action: string }>).map((x) => x.action);
    expect(actions).toContain("camera.exported");
    expect(actions).toContain("camera.export_requested");
  });

  test('visualizador: sem "pode reproduzir" vê o aviso; com ele reproduz, mas não exporta', async ({
    page,
    request,
  }) => {
    const token = await apiToken(request, ADMIN_EMAIL, ADMIN_PASSWORD);
    const auth = { headers: { authorization: `Bearer ${token}` } };
    const cam = await cam001(request, token);
    const stamp = Date.now().toString().slice(-6);
    const email = `vigia${stamp}@e2e.test`;
    const created = await request.post("/api/v1/users", {
      ...auth,
      data: { name: `Vigia ${stamp}`, email, role: "viewer", tenantId: cam.tenantId },
    });
    expect(created.status()).toBe(201);
    const { user, temporaryPassword } = await created.json();
    const grant = (items: unknown[]) =>
      request.put(`/api/v1/users/${user.id}/camera-permissions`, { ...auth, data: { items } });
    await grant([{ cameraId: cam.id, canLive: true }]);

    try {
      await login(page, email, temporaryPassword);
      await changePasswordScreen(page, temporaryPassword, `Portaria${stamp}Segura`);
      await page.goto("/gravacoes");
      await expect(page.getByText("Sem permissão para gravações")).toBeVisible();

      await grant([{ cameraId: cam.id, canLive: true, canPlayback: true }]);
      await page.reload();
      await page.getByRole("button", { name: "Reproduzir" }).first().click();
      await expect(page.locator("[data-testid=recording-player]")).toHaveAttribute(
        "data-state",
        "playing",
        { timeout: 30_000 },
      );
      await expect(page.getByRole("button", { name: "Baixar MP4" })).toHaveCount(0);

      const viewer = await apiToken(request, email, `Portaria${stamp}Segura`);
      const r = await request.post(`/api/v1/cameras/${cam.id}/exports`, {
        headers: { authorization: `Bearer ${viewer}` },
        data: {
          start: new Date(Date.now() - 120_000).toISOString(),
          end: new Date(Date.now() - 60_000).toISOString(),
        },
      });
      expect(r.status()).toBe(403);
    } finally {
      await request.delete(`/api/v1/users/${user.id}`, auth);
    }
  });
});
