import { expect, test } from "@playwright/test";
import { loginAdmin } from "./helpers";

/** Clientes: usuários do cliente abertos logo abaixo dele; transferência de câmera. */

test.describe("clientes e câmeras", () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1024, "só no computador");

  test("abre os usuários do cliente, cadastra um já vinculado e edita", async ({ page }) => {
    const stamp = Date.now().toString().slice(-6);
    await loginAdmin(page);
    await page.goto("/clientes");
    await page.getByPlaceholder("Pesquisar cliente…").fill("Empresa Alfa");
    await page.getByRole("button", { name: "Usuários de Empresa Alfa" }).click();
    const panel = page.locator("[data-testid^=client-users-]");
    await expect(panel.getByRole("heading", { name: "Usuários de Empresa Alfa" })).toBeVisible();

    await panel.getByRole("button", { name: "Novo usuário neste cliente" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel("Nome *").fill(`Parente ${stamp}`);
    await dlg.getByLabel("E-mail *").fill(`parente${stamp}@e2e.test`);
    await expect(dlg.getByLabel("Cliente *")).toHaveValue(/.+/);
    await dlg.getByLabel("Senha", { exact: true }).fill(`Parente${stamp}`);
    await dlg.getByLabel("Confirmar senha").fill(`Parente${stamp}`);
    await dlg.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByText("Usuário salvo")).toBeVisible();
    await expect(panel).toContainText(`parente${stamp}@e2e.test`);

    await panel.getByRole("button", { name: `Editar Parente ${stamp}` }).click();
    await expect(page.getByRole("dialog").getByLabel("Cliente")).toHaveValue("Empresa Alfa");
    await page.getByRole("dialog").getByLabel("Nome *").fill(`Parente ${stamp} B`);
    await page.getByRole("dialog").getByRole("button", { name: "Salvar" }).click();
    await expect(panel).toContainText(`Parente ${stamp} B`);
    await page.screenshot({
      path: `reports/screens/clientes-usuarios-${test.info().project.name}.png`,
    });

    await panel.getByRole("link", { name: "Abrir em Usuários" }).click();
    await expect(page).toHaveURL(/\/usuarios\?tenantId=/);
    await expect(page.getByRole("table").getByText(`parente${stamp}@e2e.test`)).toBeVisible();
  });

  test("transferir câmera pede destino, local e confirmação", async ({ page }) => {
    await loginAdmin(page);
    await page.goto("/cameras");
    await page
      .getByRole("button", { name: /^Editar / })
      .first()
      .click();
    await page.getByRole("button", { name: "Transferir para outro cliente…" }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByTestId("transfer")).toContainText("não vão para o cliente novo");
    const go = dlg.getByRole("button", { name: "Transferir" });
    await expect(go).toBeDisabled();
    await dlg.getByLabel("Cliente de destino *").selectOption({ index: 1 });
    await expect(dlg.getByLabel("Manter a chave atual")).toBeChecked();
    await page.screenshot({ path: `reports/screens/transferir-${test.info().project.name}.png` });
    await expect(go).toBeDisabled(); // falta local e confirmação
    await dlg.getByRole("button", { name: "Cancelar" }).click();
  });
});
