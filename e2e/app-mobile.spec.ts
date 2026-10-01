import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD } from "./helpers";

/**
 * App mobile (Fase 9.1) na versão web, contra o laboratório: primeiro acesso com troca de
 * senha, câmeras liberadas por local/grupo, ao vivo (pede o endereço HLS com token),
 * mosaico, sessão mantida ao reabrir e sair.
 *
 * Pré-requisito: app exportado e servido em E2E_APP_URL (padrão http://localhost:8099):
 *   cd apps/mobile && API_URL=http://localhost:8099 npx expo export --platform web
 *   node scripts/web-preview.mjs
 * O vídeo em si (HLS) é conferido no celular: o Chromium de teste não toca HLS sem hls.js.
 */

const APP = process.env.E2E_APP_URL ?? "http://localhost:8099";
const dc = (...args: string[]) =>
  execFileSync("docker", ["compose", ...args], { encoding: "utf8" }).trim();
const psql = (q: string) =>
  dc("exec", "-T", "postgres", "psql", "-U", "topcam_owner", "-d", "topcam", "-Atq", "-c", q);
mkdirSync("reports/screens", { recursive: true });

async function adminToken(request: APIRequestContext) {
  const r = await request.post("/api/v1/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(r.ok(), "admin do painel (rode antes o E2E do painel, que troca a senha inicial)").toBe(
    true,
  );
  return (await r.json()).accessToken as string;
}

test.describe("app mobile (web)", () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) > 500, "só na largura de celular");

  const stamp = Date.now().toString(36);
  const email = `app-${stamp}@alfa.test`;
  let userId = "";
  const cams: Record<string, string> = {};

  test.beforeAll(async ({ request }) => {
    const ok = await fetch(APP)
      .then((r) => r.ok)
      .catch(() => false);
    test.skip(!ok, `app web não está no ar em ${APP}`);
    const tok = await adminToken(request);
    const h = { authorization: `Bearer ${tok}` };
    const tenant = psql("SELECT id FROM tenants WHERE slug = 'empresa-alfa'");
    for (const code of ["CAM-001", "CAM-002", "CAM-003"])
      cams[code] = psql(
        `SELECT id FROM cameras WHERE tenant_id = '${tenant}' AND code = '${code}' AND deleted_at IS NULL`,
      );
    const u = await request.post("/api/v1/users", {
      headers: h,
      data: {
        name: "Porteiro App",
        email,
        role: "viewer",
        tenantId: tenant,
        password: "Temporaria1",
        mustChangePassword: true,
      },
    });
    expect(u.ok()).toBe(true);
    userId = (await u.json()).user.id;
    await request.put(`/api/v1/users/${userId}/camera-permissions`, {
      headers: h,
      data: {
        items: [
          { cameraId: cams["CAM-001"], canLive: true },
          { cameraId: cams["CAM-002"], canLive: true },
        ],
      },
    });
    // Transmissores de teste nas duas câmeras liberadas.
    for (const code of ["CAM-001", "CAM-002"]) {
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
      execFileSync("docker", ["rm", "-f", `topcam-txapp-${code}`], { stdio: "ignore" });
      dc(
        "--profile",
        "test",
        "run",
        "-d",
        "--rm",
        "--name",
        `topcam-txapp-${code}`,
        "test-transmitter",
        "publish",
        key,
        code,
      );
    }
    await expect
      .poll(
        () =>
          psql(
            `SELECT count(*) FROM cameras WHERE id IN ('${cams["CAM-001"]}', '${cams["CAM-002"]}') AND status IN ('ao_vivo', 'gravando')`,
          ),
        { timeout: 90_000 },
      )
      .toBe("2");
  });

  test.afterAll(async ({ request }) => {
    for (const code of ["CAM-001", "CAM-002"])
      execFileSync("docker", ["rm", "-f", `topcam-txapp-${code}`], { stdio: "ignore" });
    if (userId) {
      const tok = await adminToken(request);
      await request.delete(`/api/v1/users/${userId}`, {
        headers: { authorization: `Bearer ${tok}` },
      });
    }
  });

  test("primeiro acesso, câmeras liberadas, ao vivo, mosaico, sessão mantida e sair", async ({
    page,
  }) => {
    await page.goto(APP);
    await page.getByLabel("E-mail").fill(email);
    await page.getByLabel("Senha", { exact: true }).fill("Temporaria1");
    await page.getByTestId("login-submit").click();

    // Troca obrigatória da senha.
    await expect(page.getByText("Primeiro acesso: crie uma senha só sua")).toBeVisible();
    await page.getByLabel("Senha atual (temporária)").fill("Temporaria1");
    await page.getByLabel("Nova senha", { exact: true }).fill("fraca");
    await page.getByLabel("Confirme a nova senha").fill("fraca");
    await page.getByTestId("pw-submit").click();
    await expect(page.getByText(/pelo menos 8 caracteres/)).toBeVisible();
    await page.getByLabel("Nova senha", { exact: true }).fill("PorteiroApp9");
    await page.getByLabel("Confirme a nova senha").fill("PorteiroApp9");
    await page.getByTestId("pw-submit").click();

    // Só as duas câmeras liberadas, no local e grupo.
    await expect(page.getByText("Matriz")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Externo")).toBeVisible();
    await expect(page.getByTestId("camera-row")).toHaveCount(2);
    await expect(page.getByText("Entrada Principal")).toBeVisible();
    await expect(page.getByText("Recepção")).toHaveCount(0);
    await expect(page.getByText("Online").first()).toBeVisible();
    await page.screenshot({ path: "reports/screens/app-cameras.png" });

    // Ao vivo: pede o endereço com token e o player busca a lista HLS.
    const hls = page.waitForResponse((r) => /\/live\/[^/]+\/index\.m3u8/.test(r.url()));
    await page.getByRole("button", { name: /Entrada Principal, CAM-001/ }).click();
    const r = await hls;
    expect(r.status()).toBe(200);
    expect(await r.text()).toContain("#EXTM3U");
    await expect(page.getByRole("button", { name: "Ligar som" })).toBeVisible();
    await page.getByRole("button", { name: "Ligar som" }).click();
    await expect(page.getByRole("button", { name: "Desligar som" })).toBeVisible();
    await page.screenshot({ path: "reports/screens/app-ao-vivo.png" });
    await page.goBack();

    // Mosaico do grupo (duas câmeras no ar).
    let lists = 0;
    page.on("response", (x) => {
      if (/\/live\/[^/]+\/index\.m3u8/.test(x.url()) && x.status() === 200) lists++;
    });
    await page.getByRole("button", { name: "Mosaico de Externo" }).click();
    await expect.poll(() => lists, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
    await expect(page.getByTestId(`live-${cams["CAM-001"]}`)).toBeVisible();
    await expect(page.getByTestId(`live-${cams["CAM-002"]}`)).toBeVisible();
    await page.screenshot({ path: "reports/screens/app-mosaico.png" });

    // Fechar e abrir de novo: continua logado (refresh token guardado).
    await page.goto(APP);
    await expect(page.getByTestId("camera-row")).toHaveCount(2, { timeout: 15_000 });

    // Conta e sair.
    await page.getByRole("tab", { name: /Conta/ }).click();
    await expect(page.getByText(email)).toBeVisible();
    await expect(page.getByText("Visualizador")).toBeVisible();
    await page.getByTestId("logout").click();
    await expect(page.getByTestId("login-submit")).toBeVisible();
    await page.goto(APP);
    await expect(page.getByTestId("login-submit")).toBeVisible();

    // Entra de novo com a senha nova, sem pedir troca.
    await page.getByLabel("E-mail").fill(email);
    await page.getByLabel("Senha", { exact: true }).fill("PorteiroApp9");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("camera-row")).toHaveCount(2, { timeout: 15_000 });
  });
});
