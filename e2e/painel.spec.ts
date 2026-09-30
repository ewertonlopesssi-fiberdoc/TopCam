import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { changePasswordScreen, login, loginAdmin, logout, noHorizontalOverflow } from "./helpers";

const stamp = Date.now().toString().slice(-6);

/** Navega pelo menu lateral e espera o título da página. */
async function go(page: Page, link: string, heading: string) {
  await page
    .getByRole("navigation", { name: "Menu principal" })
    .getByRole("link", { name: link, exact: true })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
}
mkdirSync("reports/screens", { recursive: true });

test.describe("login", () => {
  test("recusa senha errada", async ({ page }) => {
    await page.goto("/login");
    // E-mail fictício: não consome o limite de tentativas do administrador.
    await page.getByLabel("E-mail").fill(`ninguem${stamp}@e2e.test`);
    await page.getByLabel("Senha", { exact: true }).fill("senha-errada-123");
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page.getByText("E-mail ou senha inválidos")).toBeVisible();
  });

  test("páginas do painel exigem login", async ({ page }) => {
    await page.goto("/cameras");
    await page.waitForURL(/\/login\?next=%2Fcameras/);
  });
});

test.describe("fluxo do administrador e do visualizador", () => {
  test.skip(
    ({ viewport }) => (viewport?.width ?? 0) < 1024,
    "fluxo completo roda na largura de computador",
  );

  test("cadastra cliente, local, câmera e usuário; o visualizador só vê a câmera liberada", async ({
    page,
  }) => {
    const cliente = `Cliente E2E ${stamp}`;
    const camera = `Portão E2E ${stamp}`;
    const viewerEmail = `visualizador${stamp}@e2e.test`;

    await loginAdmin(page);
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

    // ---- cliente
    await go(page, "Clientes", "Clientes / Empresas");
    await page.getByRole("button", { name: "Novo Cliente" }).click();
    const dlg = page.getByRole("dialog", { name: "Novo cliente" });
    await dlg.getByLabel("Nome *").fill(cliente);
    await dlg.getByLabel("E-mail de contato").fill(`contato${stamp}@e2e.test`);
    // O acesso do cliente (administrador) é criado junto, com o e-mail de contato.
    await expect(dlg.getByLabel("E-mail de acesso *")).toHaveValue(`contato${stamp}@e2e.test`);
    await dlg.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByTestId("temp-password")).toBeVisible();
    await page.getByRole("button", { name: "Entendi" }).click();
    await page.getByPlaceholder("Pesquisar cliente…").fill(cliente);
    const row = page.locator("tr", { hasText: cliente });
    await expect(row).toBeVisible();
    await expect(row.getByText("Ativo")).toBeVisible();

    // ---- local e grupo
    await go(page, "Grupos / Locais", "Grupos / Locais");
    await page.getByLabel("Cliente", { exact: true }).selectOption({ label: cliente });
    await page.getByRole("button", { name: "Novo Local" }).click();
    await page.getByRole("dialog").getByLabel("Nome *").fill("Matriz");
    await page.getByRole("dialog").getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByRole("heading", { name: "Matriz" })).toBeVisible();
    await page.getByRole("button", { name: "Adicionar grupo" }).click();
    await page.getByRole("dialog").getByLabel("Nome *").fill("Portaria");
    await page.getByRole("dialog").getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByText("Portaria")).toBeVisible();

    // ---- câmera (chave exclusiva gerada)
    await go(page, "Câmeras", "Câmeras");
    await page.getByRole("button", { name: "Nova Câmera" }).click();
    const cam = page.getByRole("dialog", { name: "Nova câmera" });
    await cam.getByLabel("Cliente *").selectOption({ label: cliente });
    await cam.getByLabel("Nome *").fill(camera);
    await cam.getByLabel("Local *").selectOption({ label: "Matriz" });
    await cam.getByLabel("Grupo").selectOption({ label: "Portaria" });
    await cam.getByRole("button", { name: "Cadastrar e gerar chave" }).click();
    const created = page.getByRole("dialog", { name: "Câmera cadastrada" });
    await expect(created.getByLabel("Servidor (URL)")).toHaveValue(/^rtmp:\/\/.+:1935\/live$/);
    await expect(created.getByTestId("stream-key")).toHaveValue(/^[A-Za-z0-9]{40}$/);
    await created.getByRole("button", { name: "Concluir" }).click();
    await page.getByPlaceholder("Pesquisar câmera…").fill(camera);
    // Equipe da plataforma vê as câmeras agrupadas por cliente; a pesquisa já abre o cliente.
    const camRow = page.locator("tr", { hasText: camera }).last();
    await expect(camRow.getByText("CAM-001")).toBeVisible();
    await expect(camRow.getByText("Aguardando")).toBeVisible();

    // ---- detalhes: exibir a chave (auditado)
    await camRow.getByRole("button", { name: "Detalhes de CAM-001" }).click();
    await page.getByRole("button", { name: "Exibir dados de configuração" }).click();
    await expect(page.getByTestId("stream-key")).toHaveValue(/^[A-Za-z0-9]{40}$/);
    await page
      .getByRole("dialog", { name: /CAM-001/ })
      .getByRole("button", { name: "Fechar" })
      .click();

    // ---- usuário visualizador + permissão
    await go(page, "Usuários", "Usuários");
    await page.getByRole("button", { name: "Novo Usuário" }).click();
    const u = page.getByRole("dialog", { name: "Novo usuário" });
    await u.getByLabel("Nome *").fill(`Visualizador ${stamp}`);
    await u.getByLabel("E-mail *").fill(viewerEmail);
    await u.getByLabel("Papel *").selectOption({ label: "Visualizador" });
    await u.getByLabel("Cliente *").selectOption({ label: cliente });
    await u.getByRole("button", { name: "Salvar" }).click();
    const temp = (await page.getByTestId("temp-password").textContent())!.trim();
    expect(temp).toMatch(/^[A-Za-z0-9]{14}$/);
    await page.getByRole("button", { name: "Entendi" }).click();

    await page.getByPlaceholder("Pesquisar nome ou e-mail…").fill(viewerEmail);
    const userRow = page.locator("tr", { hasText: viewerEmail });
    await userRow.getByRole("button", { name: `Câmeras de Visualizador ${stamp}` }).click();
    const perms = page.getByRole("dialog", { name: `Câmeras de Visualizador ${stamp}` });
    await perms.getByRole("checkbox").first().check();
    await perms.getByRole("button", { name: "Salvar permissões" }).click();
    await expect(userRow.getByText("1 liberada(s)")).toBeVisible();

    // ---- limites dos planos (Configurações)
    await go(page, "Configurações", "Configurações");
    const planRow = page.locator("tr", { hasText: "Básico" });
    await planRow.getByRole("button", { name: /Editar plano/ }).click();
    const planDialog = page.getByRole("dialog");
    await expect(planDialog.getByLabel("Máximo de câmeras")).toHaveValue(/\d+/);
    await planDialog.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByText("Plano atualizado")).toBeVisible();

    // ---- auditoria
    await go(page, "Auditoria", "Auditoria");
    await expect(page.getByText("Plano alterado").first()).toBeVisible();
    await expect(page.getByText("Permissões de câmeras alteradas").first()).toBeVisible();
    await expect(page.getByText("Chave RTMP exibida").first()).toBeVisible();

    // ---- visualizador: primeiro acesso e visibilidade
    await logout(page);
    await login(page, viewerEmail, temp);
    await changePasswordScreen(page, temp, `Acesso${stamp}Seguro`);
    const nav = page.getByRole("navigation", { name: "Menu principal" });
    await expect(nav.getByRole("link", { name: "Clientes" })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "Usuários" })).toHaveCount(0);
    await go(page, "Câmeras", "Câmeras");
    await expect(page.locator("tr", { hasText: camera })).toBeVisible();
    await expect(page.getByText("Mostrando 1 a 1 de 1 registro")).toBeVisible();
    await expect(page.getByRole("button", { name: "Nova Câmera" })).toHaveCount(0);
    await page
      .locator("tr", { hasText: camera })
      .getByRole("button", { name: "Detalhes de CAM-001" })
      .click();
    await expect(page.getByRole("dialog", { name: /CAM-001/ })).toBeVisible();
    await expect(page.getByText("Configuração RTMP")).toHaveCount(0);
  });
});

test.describe("telas responsivas", () => {
  const pages = [
    ["dashboard", "Dashboard"],
    ["clientes", "Clientes / Empresas"],
    ["usuarios", "Usuários"],
    ["grupos", "Grupos / Locais"],
    ["cameras", "Câmeras"],
    ["configuracoes", "Configurações"],
    ["auditoria", "Auditoria"],
    ["ao-vivo", "Ao Vivo"],
  ] as const;

  test("todas as telas cabem na largura e o menu se adapta", async ({ page }, info) => {
    await loginAdmin(page);
    for (const [path, heading] of pages) {
      await page.goto(`/${path}`);
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
      await page.waitForLoadState("networkidle");
      if (path === "ao-vivo" && process.env.E2E_LIVE === "1") {
        const client = page.getByLabel("Cliente");
        if (await client.count()) await client.selectOption({ label: "Empresa Alfa" });
        await expect(page.locator("[data-testid=live-tile]").first()).toHaveAttribute(
          "data-state",
          "playing",
          { timeout: 20_000 },
        );
        await page.waitForTimeout(1500);
      }
      await noHorizontalOverflow(page);
      await page.screenshot({
        path: `reports/screens/${info.project.name}-${path}.png`,
        fullPage: true,
      });
    }
    const nav = page.getByRole("navigation", { name: "Menu principal" });
    if ((page.viewportSize()?.width ?? 0) >= 1024) {
      await expect(nav).toBeVisible();
      await expect(page.getByRole("button", { name: "Abrir menu" })).toBeHidden();
    } else {
      await expect(nav).toBeHidden();
      await page.getByRole("button", { name: "Abrir menu" }).click();
      await expect(nav.getByRole("link", { name: "Câmeras" })).toBeVisible();
      await page.screenshot({ path: `reports/screens/${info.project.name}-menu.png` });
      await nav.getByRole("link", { name: "Câmeras" }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Câmeras" })).toBeVisible();
      await expect(nav).toBeHidden();
    }
    await page.goto("/login");
  });
});
