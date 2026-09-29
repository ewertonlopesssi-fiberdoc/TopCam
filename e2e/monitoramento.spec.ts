import { expect, test } from "@playwright/test";
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  changePasswordScreen,
  login,
  loginAdmin,
  noHorizontalOverflow,
} from "./helpers";

/** Monitoramento (Fase 7): Dashboard, Eventos e Alertas, Relatórios e Integrações. */

const shot = (name: string) => `reports/screens/${name}-${test.info().project.name}.png`;

test.describe("monitoramento", () => {
  test("Dashboard mostra alertas, eventos e disco", async ({ page }) => {
    await loginAdmin(page);
    await page.goto("/dashboard");
    const mon = page.getByTestId("dashboard-monitor");
    await expect(mon).toBeVisible();
    await expect(mon.getByRole("heading", { name: "Alertas ativos" })).toBeVisible();
    await expect(mon.getByRole("heading", { name: "Últimos eventos" })).toBeVisible();
    await expect(mon.getByRole("heading", { name: "Disco de vídeo" })).toBeVisible();
    await expect(mon.getByRole("heading", { name: "Usuários conectados" })).toBeVisible();
    await noHorizontalOverflow(page);
    await page.screenshot({ path: shot("dashboard"), fullPage: true });
  });

  test("Eventos e Alertas: abas, filtros e detalhes", async ({ page }) => {
    await loginAdmin(page);
    await page.goto("/eventos");
    await expect(page.getByRole("tab", { name: "Alertas" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByTestId("alerts")).toBeVisible();
    await page.getByLabel("Situação").selectOption("all");
    await page.getByRole("tab", { name: "Eventos" }).click();
    const events = page.getByTestId("events");
    await expect(events.locator("tbody tr").first()).toBeVisible();
    await page.getByLabel("Tipo").selectOption("publish_authorized");
    await expect(events.locator("tbody tr").first()).toContainText("Transmissão autorizada");
    await noHorizontalOverflow(page);
    await page.screenshot({ path: shot("eventos"), fullPage: true });
  });

  test("Relatórios: tabela de disponibilidade e CSV", async ({ page }) => {
    await loginAdmin(page);
    await page.goto("/relatorios");
    const table = page.getByTestId("availability");
    await expect(table.locator("thead")).toContainText("Disponibilidade");
    await expect(table.locator("tbody tr").first()).toBeVisible();
    await noHorizontalOverflow(page);
    await page.screenshot({ path: shot("relatorios"), fullPage: true });
    if ((page.viewportSize()?.width ?? 0) >= 1024) {
      const [dl] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("button", { name: "Baixar CSV" }).click(),
      ]);
      expect(dl.suggestedFilename()).toMatch(
        /^disponibilidade_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/,
      );
    }
  });

  test("Integrações: campos do SMTP, atalho do Gmail e validação", async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) < 1024, "só no computador");
    await loginAdmin(page);
    await page.goto("/configuracoes");
    const card = page.getByTestId("integrations");
    await expect(card.getByRole("heading", { name: "E-mail (SMTP) — alertas" })).toBeVisible();
    await card.getByLabel("Servidor SMTP").fill("");
    await card.getByRole("button", { name: "Preencher para Gmail" }).click();
    await expect(card.getByLabel("Servidor SMTP")).toHaveValue("smtp.gmail.com");
    await expect(card.getByLabel("Porta")).toHaveValue("587");
    await expect(card.getByLabel("Segurança")).toHaveValue("starttls");
    await expect(card).toContainText("senha de app");
    await page.screenshot({ path: shot("integracoes"), fullPage: true });
    // Ativar sem destinatários é recusado e nada é salvo.
    const was = await card.getByLabel("Enviar alertas por e-mail").isChecked();
    await card.getByLabel("Destinatários (um por linha)").fill("");
    if (!was) await card.getByLabel("Enviar alertas por e-mail").check();
    await card.getByRole("button", { name: "Salvar" }).click();
    await expect(card.getByRole("alert")).toContainText(/destinatário|servidor|senha/i);
  });

  test("usuário de cliente: sem Integrações, com Relatórios do próprio cliente", async ({
    page,
    request,
  }) => {
    test.skip((page.viewportSize()?.width ?? 0) < 1024, "só no computador");
    const r = await request.post("/api/v1/auth/login", {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    const token = (await r.json()).accessToken as string;
    const auth = { headers: { authorization: `Bearer ${token}` } };
    const tenants = (await (await request.get("/api/v1/tenants?pageSize=100", auth)).json())
      .items as Array<{ id: string; name: string }>;
    const alfa = tenants.find((t) => t.name === "Empresa Alfa")!;
    const stamp = Date.now().toString().slice(-6);
    const email = `gestor7${stamp}@e2e.test`;
    const created = await request.post("/api/v1/users", {
      ...auth,
      data: { name: `Gestor ${stamp}`, email, role: "tenant_admin", tenantId: alfa.id },
    });
    const { user, temporaryPassword } = await created.json();
    try {
      await login(page, email, temporaryPassword);
      await changePasswordScreen(page, temporaryPassword, `Cliente${stamp}Seguro`);
      await page.goto("/configuracoes");
      await expect(page.getByRole("heading", { name: "Minha conta" })).toBeVisible();
      await expect(page.getByTestId("integrations")).toHaveCount(0);
      await page.getByRole("link", { name: "Relatórios" }).click();
      const table = page.getByTestId("availability");
      await expect(table.locator("tbody tr").first()).toBeVisible();
      await expect(table.locator("thead")).not.toContainText("Cliente");
      const t2 = (
        await (
          await request.post("/api/v1/auth/login", {
            data: { email, password: `Cliente${stamp}Seguro` },
          })
        ).json()
      ).accessToken as string;
      expect(
        (
          await request.get("/api/v1/integrations", { headers: { authorization: `Bearer ${t2}` } })
        ).status(),
      ).toBe(403);
    } finally {
      await request.delete(`/api/v1/users/${user.id}`, auth);
    }
  });
});
