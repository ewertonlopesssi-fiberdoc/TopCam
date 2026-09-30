import { expect, test } from "@playwright/test";
import { ADMIN_PASSWORD, loginAdmin } from "./helpers";

/** Configurações → Integrações → Backup: validação, salvar sem expor senhas, teste de conexão. */

test.describe("backup", () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1024, "só no computador");

  test("configura destino e senha do backup e testa a conexão", async ({ page }) => {
    await loginAdmin(page);
    await page.goto("/configuracoes");
    const card = page.getByTestId("backup-card");
    await expect(card.getByText("Serviço de backup ativo")).toBeVisible({ timeout: 15_000 });

    await card.getByLabel("Onde guardar").selectOption("remote");
    await card.getByLabel("Protocolo", { exact: true }).selectOption("sftp");
    await card.getByLabel("Servidor", { exact: true }).fill("backup-e2e.invalid");
    await card.getByLabel("Porta", { exact: true }).fill("22");
    await card.getByLabel("Usuário", { exact: true }).fill("bkp");
    await card.getByLabel("Autenticação").selectOption("password");
    await card.getByLabel("Senha do destino").fill("SenhaDestinoE2E");
    await card.getByLabel("Pasta no destino").fill("topcam-e2e");

    // Senhas do backup diferentes: não salva.
    const pass = card.getByLabel(/^(Nova senha do backup|Senha do backup)$/);
    await pass.fill("Senha-do-backup-E2E");
    await card.getByLabel("Confirmar senha do backup").fill("outra-coisa-123");
    await expect(card.getByText("As duas senhas não conferem.")).toBeVisible();
    await card.getByRole("button", { name: "Salvar" }).click();
    await expect(card.getByText("As duas senhas do backup não conferem")).toBeVisible();

    await card.getByLabel("Confirmar senha do backup").fill("Senha-do-backup-E2E");
    await card.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByText(/^Backup salvo(\.|$)/)).toBeVisible();
    await expect(card.getByText("definida", { exact: true })).toBeVisible();
    // A senha salva nunca volta para a tela.
    await expect(card.getByLabel("Senha do destino")).toHaveValue("");
    await expect(pass).toHaveValue("");

    await card.getByRole("button", { name: "Testar conexão" }).click();
    const hist = card.getByRole("table", { name: "Histórico do backup" });
    await expect(hist.getByText("Servidor não encontrado", { exact: false }).first()).toBeVisible({
      timeout: 60_000,
    });
  });

  test("somente no servidor: faz o backup pela tela e baixa com a senha confirmada", async ({
    page,
  }) => {
    await loginAdmin(page);
    await page.goto("/configuracoes");
    const card = page.getByTestId("backup-card");
    await expect(card.getByText("Serviço de backup ativo")).toBeVisible({ timeout: 15_000 });

    await card.getByLabel("Onde guardar").selectOption("local");
    await expect(card.getByText(/Os arquivos ficam só nesta VM/)).toBeVisible();
    await expect(card.getByLabel("Servidor", { exact: true })).toHaveCount(0);
    await card.getByLabel("Cópias no servidor").fill("2");
    const pass = card.getByLabel(/^(Nova senha do backup|Senha do backup)$/);
    await pass.fill("Senha-do-backup-E2E");
    await card.getByLabel("Confirmar senha do backup").fill("Senha-do-backup-E2E");
    await card.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByText(/^Backup salvo(\.|$)/)).toBeVisible();
    await expect(card.getByRole("button", { name: "Testar conexão" })).toHaveCount(0);

    await card.getByRole("button", { name: "Fazer backup agora" }).click();
    const hist = card.getByRole("table", { name: "Histórico do backup" });
    await expect(hist.getByText(/Backup salvo no servidor/).first()).toBeVisible({
      timeout: 90_000,
    });

    const first = hist.getByRole("button", { name: /^Baixar topcam-/ }).first();
    await first.click();
    const dlg = page.getByRole("dialog", { name: "Baixar backup" });
    await dlg.getByLabel("Confirme sua senha de acesso ao painel").fill("senha-errada-1");
    await dlg.getByRole("button", { name: "Baixar" }).click();
    await expect(dlg.getByText("Senha incorreta")).toBeVisible();

    await dlg.getByLabel("Confirme sua senha de acesso ao painel").fill(ADMIN_PASSWORD);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      dlg.getByRole("button", { name: "Baixar" }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^topcam-\d{8}-\d{6}\.tar\.gpg$/);
    const size = (await (await import("node:fs/promises")).stat((await download.path())!)).size;
    expect(size).toBeGreaterThan(1000);
  });
});
