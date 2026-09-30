import { expect, test } from "@playwright/test";
import { loginAdmin } from "./helpers";

/** Configurações → Firewall: adicionar, editar e remover redes do SSH. */

test("firewall: adiciona, edita e remove uma rede do SSH", async ({ page }) => {
  const oct = 10 + ((Date.now() + test.info().project.name.length * 37) % 200);
  const net = `10.${oct}.0.0/16`;
  await loginAdmin(page);
  await page.goto("/configuracoes");
  const card = page.getByTestId("firewall-card");
  await expect(card.getByRole("heading", { name: "Firewall do servidor" })).toBeVisible();

  // Rede inválida: mensagem em português, nada salvo.
  await card.getByRole("button", { name: "Adicionar rede" }).click();
  let dlg = page.getByRole("dialog");
  await dlg.getByLabel("IP/máscara").fill("0.0.0.0/0");
  await dlg.getByRole("button", { name: "Salvar" }).click();
  await expect(dlg).toContainText("o mínimo é /8");

  // Com bits de host: salva a faixa normalizada.
  await dlg.getByLabel("IP/máscara").fill(`10.${oct}.7.9/16`);
  await dlg.getByLabel("Descrição").fill("Escritório E2E");
  await dlg.getByRole("button", { name: "Salvar" }).click();
  await expect(page.getByText("O servidor aplica em até 1 minuto")).toBeVisible();
  await expect(card.getByRole("cell", { name: net, exact: true })).toBeVisible();
  await expect(card).toContainText("Escritório E2E");

  await card.getByRole("button", { name: `Editar rede ${net}` }).click();
  dlg = page.getByRole("dialog");
  await dlg.getByLabel("Descrição").fill("Escritório E2E (editado)");
  await dlg.getByRole("button", { name: "Salvar" }).click();
  await expect(card).toContainText("Escritório E2E (editado)");

  await card.getByRole("button", { name: `Remover rede ${net}` }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remover" }).click();
  await expect(page.getByText("Rede removida")).toBeVisible();
  await expect(card.getByRole("cell", { name: net, exact: true })).toHaveCount(0);
});
