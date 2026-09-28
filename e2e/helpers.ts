import { expect, type Page } from "@playwright/test";

export const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@topcam.local";
export const ADMIN_INITIAL = process.env.E2E_ADMIN_PASSWORD ?? "";
export const ADMIN_PASSWORD = process.env.E2E_ADMIN_NEW_PASSWORD ?? "PainelE2E-2026x";

/** Entra como administrador; no primeiro acesso, faz a troca obrigatória de senha pela tela. */
export async function loginAdmin(page: Page) {
  const probe = await page.request.post("/api/v1/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (probe.ok() && !(await probe.json()).user.mustChangePassword) {
    // O login pela API já deixou o cookie de sessão no navegador.
    await page.goto("/dashboard");
    await page.waitForURL(/\/dashboard/);
    return;
  }
  await login(page, ADMIN_EMAIL, ADMIN_INITIAL);
  await changePasswordScreen(page, ADMIN_INITIAL, ADMIN_PASSWORD);
}

export async function login(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL(/\/(dashboard|trocar-senha)/);
}

export async function changePasswordScreen(page: Page, current: string, next: string) {
  await expect(page).toHaveURL(/trocar-senha/);
  await page.getByLabel("Senha atual (temporária)").fill(current);
  await page.getByLabel("Nova senha", { exact: true }).fill(next);
  await page.getByLabel("Confirme a nova senha").fill(next);
  await page.getByRole("button", { name: "Salvar nova senha" }).click();
  await page.waitForURL(/\/dashboard/);
}

export async function logout(page: Page) {
  await page.locator("header").getByRole("button", { expanded: false }).last().click();
  await page.getByRole("menuitem", { name: "Sair" }).click();
  await page.waitForURL(/\/login/);
}

/** Área visível da lista (tabela no computador/tablet, cartões no celular). */
export function list(page: Page) {
  return page.locator("table:visible, ul.md\\:hidden:visible").first();
}

export async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow, "a página não deve rolar na horizontal").toBeLessThanOrEqual(1);
}
