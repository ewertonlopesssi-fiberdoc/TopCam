import { expect, test } from "@playwright/test";
import { loginAdmin } from "./helpers";

/** Configurações → Integrações → Backup: validação, salvar sem expor senhas, teste de conexão. */

test.describe("backup", () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1024, "só no computador");

  test("configura destino e senha do backup e testa a conexão", async ({ page }) => {
    await loginAdmin(page);
    await page.goto("/configuracoes");
    const card = page.getByTestId("backup-card");
    await expect(card.getByText("Serviço de backup ativo")).toBeVisible({ timeout: 15_000 });

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
    await expect(page.getByText(/^Backup salvo/)).toBeVisible();
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
});
