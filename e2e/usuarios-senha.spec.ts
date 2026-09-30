import { expect, test } from "@playwright/test";
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  login,
  loginAdmin,
  logout,
  noHorizontalOverflow,
} from "./helpers";

/** Usuários: senha digitada no cadastro, regra de senha, alterar senha e opção de e-mail. */

test.describe("usuários — senha e acesso", () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1024, "só no computador");

  test("cadastro com senha digitada entra direto; alterar senha pela lista", async ({
    page,
    request,
  }) => {
    const stamp = Date.now().toString().slice(-6);
    const email = `senha${stamp}@e2e.test`;
    await loginAdmin(page);
    await page.goto("/usuarios");
    await page.getByRole("button", { name: /Novo usuário/i }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Nome *").fill(`Senha ${stamp}`);
    await dialog.getByLabel("E-mail *").fill(email);
    await dialog.getByLabel("Papel *").selectOption({ label: "Visualizador" });
    const cliente = dialog.getByLabel("Cliente *");
    if (await cliente.count()) await cliente.selectOption({ label: "Empresa Alfa" });

    // Regra: senha fraca mostra o motivo e não salva.
    await dialog.getByLabel("Senha", { exact: true }).fill("fraca123");
    await expect(dialog.getByTestId("password-fields")).toContainText("maiúscula");
    await dialog.getByLabel("Confirmar senha").fill("fraca123");
    await dialog.getByRole("button", { name: "Salvar" }).click();
    await expect(dialog.getByRole("alert")).toContainText("maiúscula");

    // Senha válida: sem troca obrigatória por padrão.
    await dialog.getByLabel("Senha", { exact: true }).fill(`Vizinho${stamp}`);
    await dialog.getByLabel("Confirmar senha").fill(`Vizinho${stamp}`);
    await expect(dialog.getByLabel("Exigir troca de senha no primeiro acesso")).not.toBeChecked();
    await page.screenshot({
      path: `reports/screens/usuario-senha-${test.info().project.name}.png`,
    });
    await dialog.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByText("Usuário salvo")).toBeVisible();

    const r = await request.post("/api/v1/auth/login", {
      data: { email, password: `Vizinho${stamp}` },
    });
    expect(r.status()).toBe(200);
    expect((await r.json()).user.mustChangePassword).toBe(false);

    // Na edição, o cliente aparece (só leitura).
    await page.getByPlaceholder("Pesquisar nome ou e-mail…").fill(email);
    await page.getByRole("button", { name: `Editar Senha ${stamp}` }).click();
    await expect(page.getByRole("dialog").getByLabel("Cliente")).toHaveValue("Empresa Alfa");
    await expect(page.getByRole("dialog").getByLabel("Cliente")).toBeDisabled();
    await page.getByRole("dialog").getByRole("button", { name: "Cancelar" }).click();

    // Alterar senha pela lista (em branco = gerada, com troca obrigatória).
    await page.getByRole("button", { name: `Alterar senha de Senha ${stamp}` }).click();
    const modal = page.getByRole("dialog");
    await expect(modal.getByLabel("Exigir troca de senha no primeiro acesso")).toBeChecked();
    await modal.getByRole("button", { name: "Salvar senha" }).click();
    const temp = (await page.getByTestId("temp-password").textContent())!.trim();
    expect(temp).toMatch(/^(?=.*[A-Z])(?=.*[a-z])(?=.*\d).{8,}$/);
    await page.getByRole("button", { name: "Entendi" }).click();
    expect(
      (
        await request.post("/api/v1/auth/login", { data: { email, password: `Vizinho${stamp}` } })
      ).status(),
    ).toBe(401);
    await logout(page);
    await login(page, email, temp);
    await expect(page).toHaveURL(/trocar-senha/);
    await expect(page.getByText("1 letra maiúscula")).toBeVisible();
    await noHorizontalOverflow(page);

    // Limpeza.
    const t = (
      await (
        await request.post("/api/v1/auth/login", {
          data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
        })
      ).json()
    ).accessToken as string;
    const auth = { headers: { authorization: `Bearer ${t}` } };
    const list = await (
      await request.get(`/api/v1/users?search=${encodeURIComponent(email)}`, auth)
    ).json();
    for (const u of list.items) await request.delete(`/api/v1/users/${u.id}`, auth);
  });

  test("opção de e-mail aparece desativada sem a integração configurada", async ({
    page,
    request,
  }) => {
    const t = (
      await (
        await request.post("/api/v1/auth/login", {
          data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
        })
      ).json()
    ).accessToken as string;
    const enabled = (
      await (
        await request.get("/api/v1/users/mail-status", {
          headers: { authorization: `Bearer ${t}` },
        })
      ).json()
    ).enabled as boolean;
    await loginAdmin(page);
    await page.goto("/usuarios");
    await page.getByRole("button", { name: /Novo usuário/i }).click();
    const box = page.getByRole("dialog").getByLabel("Enviar usuário e senha por e-mail");
    if (enabled) await expect(box).toBeEnabled();
    else {
      await expect(box).toBeDisabled();
      await expect(page.getByRole("dialog")).toContainText("Configurações → Integrações");
    }
  });
});
