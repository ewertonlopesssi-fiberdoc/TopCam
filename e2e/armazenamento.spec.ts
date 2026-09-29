import { expect, test } from "@playwright/test";
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  changePasswordScreen,
  login,
  loginAdmin,
  noHorizontalOverflow,
} from "./helpers";

/** Armazenamento e Servidores (Fase 6): conteúdo, edição de limites e acesso. */

test.describe("armazenamento e servidores", () => {
  test("Armazenamento mostra o disco, gráficos, limpeza de emergência e uso por cliente", async ({
    page,
  }) => {
    await loginAdmin(page);
    await page.goto("/armazenamento");
    const node = page.locator("[data-testid=storage-node]").first();
    await expect(node).toBeVisible();
    await expect(node.getByText("Disco de vídeo · storage-01")).toBeVisible();
    await expect(node.getByRole("meter", { name: "Uso do disco" })).toBeVisible();
    await expect(node.getByText("Latência de escrita", { exact: true })).toBeVisible();
    await expect(page.getByTestId("purge-settings")).toContainText("mesmo dentro da retenção");
    await expect(page.getByRole("heading", { name: "Uso por cliente" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Uso por câmera" })).toBeVisible();
    await noHorizontalOverflow(page);
    await page.screenshot({
      path: `reports/screens/armazenamento-${test.info().project.name}.png`,
      fullPage: true,
    });
  });

  test("limites precisam ser crescentes", async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) < 1024, "só no computador");
    await loginAdmin(page);
    await page.goto("/armazenamento");
    await page.getByRole("button", { name: "Limites e cota" }).first().click();
    await page.getByLabel("Atenção (%)").fill("90");
    await page.getByRole("button", { name: "Salvar" }).last().click();
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText("crescentes");
    await page.getByLabel("Atenção (%)").fill("70");
    await page.getByRole("button", { name: "Salvar" }).last().click();
    await expect(page.getByText("Limites salvos")).toBeVisible();
  });

  test("Servidores mostra recursos, pressão de IO e serviços", async ({ page }) => {
    await loginAdmin(page);
    await page.goto("/servidores");
    const node = page.getByTestId("server-node").first();
    await expect(node).toBeVisible();
    await expect(node.getByText("Espera por disco (IO)")).toBeVisible();
    await expect(node.getByTestId("services")).toContainText("Banco de dados: ok", {
      timeout: 60_000,
    });
    await noHorizontalOverflow(page);
    await page.screenshot({
      path: `reports/screens/servidores-${test.info().project.name}.png`,
      fullPage: true,
    });
  });

  test("usuário de cliente não vê as telas nem a API", async ({ page, request }) => {
    test.skip((page.viewportSize()?.width ?? 0) < 1024, "só no computador");
    const r = await request.post("/api/v1/auth/login", {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    const token = (await r.json()).accessToken as string;
    const auth = { headers: { authorization: `Bearer ${token}` } };
    const tenants = (await (await request.get("/api/v1/tenants?pageSize=100", auth)).json())
      .items as Array<{
      id: string;
      name: string;
    }>;
    const alfa = tenants.find((t) => t.name === "Empresa Alfa")!;
    const stamp = Date.now().toString().slice(-6);
    const email = `gestor${stamp}@e2e.test`;
    const created = await request.post("/api/v1/users", {
      ...auth,
      data: { name: `Gestor ${stamp}`, email, role: "tenant_admin", tenantId: alfa.id },
    });
    const { user, temporaryPassword } = await created.json();
    try {
      await login(page, email, temporaryPassword);
      await changePasswordScreen(page, temporaryPassword, `Cliente${stamp}Seguro`);
      await expect(page.getByRole("link", { name: "Armazenamento" })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Servidores" })).toHaveCount(0);
      const t2 = (
        await (
          await request.post("/api/v1/auth/login", {
            data: { email, password: `Cliente${stamp}Seguro` },
          })
        ).json()
      ).accessToken as string;
      expect(
        (
          await request.get("/api/v1/storage", { headers: { authorization: `Bearer ${t2}` } })
        ).status(),
      ).toBe(403);
    } finally {
      await request.delete(`/api/v1/users/${user.id}`, auth);
    }
  });
});
