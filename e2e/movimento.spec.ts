import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { loginAdmin, noHorizontalOverflow } from "./helpers";

/**
 * Movimento e alarme: cadastro da câmera (gravação só com movimento, origem, alarme com
 * horários, credencial de eventos) e a marcação de movimento na linha do tempo.
 * Roda contra o Compose do laboratório (usa o psql do contêiner para preparar a linha do tempo).
 */

const psql = (q: string) =>
  execFileSync(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "topcam_owner",
      "-d",
      "topcam",
      "-Atq",
      "-c",
      q,
    ],
    { encoding: "utf8" },
  ).trim();

test.describe("movimento e alarme", () => {
  test("cadastro: gravação só com movimento, alarme com horário e credencial de eventos", async ({
    page,
  }) => {
    const stamp = Date.now().toString(36);
    const nome = `Movimento E2E ${stamp}`;
    await loginAdmin(page);
    await page.goto("/cameras");
    await page.getByRole("button", { name: /Nova Câmera/i }).click();
    const dlg = page.getByRole("dialog", { name: "Nova câmera" });
    await dlg.getByLabel("Cliente *").selectOption({ label: "Empresa Alfa" });
    await dlg.getByLabel("Nome *").fill(nome);
    await dlg.getByLabel("Local *").selectOption({ label: "Matriz" });

    await dlg.getByLabel("Gravação", { exact: true }).selectOption("motion");
    await expect(dlg.getByText(/Guarda cada movimento com 10 s antes/)).toBeVisible();
    // Sem origem do movimento, o servidor recusa (e a tela avisa antes).
    await expect(
      dlg.getByText("Escolha abaixo de onde vem a detecção de movimento.", { exact: false }),
    ).toBeVisible();
    await expect(dlg.getByTestId("alarm-enabled")).toBeDisabled();

    await dlg.getByLabel("Detecção de movimento").selectOption("server");
    await expect(dlg.getByLabel(/Sensibilidade/)).toBeVisible();
    await dlg.getByTestId("alarm-enabled").check();
    await expect(dlg.getByText("Sempre (todos os dias, 24 h).")).toBeVisible();
    await dlg.getByRole("button", { name: "Adicionar horário" }).click();
    const rule = dlg.getByTestId("alarm-rule");
    await expect(rule).toHaveCount(1);
    // Tira o domingo da faixa padrão (todos os dias, 22:00–06:00).
    await rule.getByRole("button", { name: "Domingo" }).click();
    await expect(rule.getByRole("button", { name: "Domingo" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await dlg.getByLabel("Intervalo mínimo entre avisos").selectOption("900");
    await noHorizontalOverflow(page);

    await dlg.getByRole("button", { name: "Cadastrar e gerar chave" }).click();
    const created = page.getByRole("dialog", { name: "Câmera cadastrada" });
    await created.getByRole("button", { name: "Concluir" }).click();

    // Confere pelo banco o que foi salvo.
    const row = psql(
      `SELECT recording_enabled || '|' || recording_mode || '|' || motion_source || '|' || alarm_enabled || '|' ||
              alarm_cooldown_s || '|' || (alarm_schedule->'rules'->0->>'from') || '|' || (alarm_schedule->'rules'->0->'days')::text
         FROM cameras WHERE name = '${nome}'`,
    );
    expect(row).toBe("true|motion|server|true|900|22:00|[1, 2, 3, 4, 5, 6]");

    // Detalhes e troca para detecção pela câmera, com a credencial de eventos.
    await page.getByPlaceholder("Pesquisar câmera…").fill(nome);
    const camRow = page.locator("tr:visible, li:visible", { hasText: nome }).last();
    await camRow.getByRole("button", { name: /^Editar CAM-/ }).click();
    const edit = page.getByRole("dialog", { name: /^Editar CAM-/ });
    await expect(edit.getByLabel("Gravação", { exact: true })).toHaveValue("motion");
    await expect(edit.getByTestId("alarm-rule")).toHaveCount(1);
    await edit.getByLabel("Detecção de movimento").selectOption("camera");
    await expect(edit.getByText(/gere o usuário e a senha/)).toBeVisible();
    await edit.getByRole("button", { name: "Salvar" }).click();
    await expect(edit).toBeHidden();

    await camRow.getByRole("button", { name: /^Detalhes de CAM-/ }).click();
    const drawer = page.getByRole("dialog", { name: new RegExp(nome) });
    await expect(drawer.getByText(/Só com movimento/)).toBeVisible();
    await expect(drawer.getByText("Pela câmera (aviso por e-mail)")).toBeVisible();
    const box = drawer.getByTestId("motion-credential");
    await box.getByRole("button", { name: "Gerar usuário e senha" }).click();
    const data = box.getByTestId("motion-credential-data");
    await expect(data.getByText(/^cam[a-z0-9]{9}$/)).toBeVisible();
    await expect(data.getByText(/^[A-Za-z0-9]{24}$/)).toBeVisible();
    await expect(data.getByText("2525", { exact: true })).toBeVisible();
    await drawer.getByRole("button", { name: "Fechar" }).click();

    // Limpeza: exclui a câmera de teste.
    psql(`UPDATE cameras SET deleted_at = now(), enabled = false, motion_smtp_user = NULL,
            code = code || '-E2E' || to_char(now(), 'HH24MISS') WHERE name = '${nome}'`);
  });

  test("linha do tempo marca o movimento em outra cor e não chama de lacuna o que não teve movimento", async ({
    page,
  }) => {
    test.skip((page.viewportSize()?.width ?? 0) < 1024, "só no computador");
    const cam = psql(
      "SELECT c.id FROM cameras c JOIN tenants t ON t.id = c.tenant_id WHERE t.slug = 'empresa-alfa' AND c.code = 'CAM-004'",
    );
    const prev = psql(`SELECT recording_enabled FROM cameras WHERE id = '${cam}'`);
    const node = psql("SELECT id FROM storage_nodes ORDER BY created_at LIMIT 1");
    const tenant = psql(`SELECT tenant_id FROM cameras WHERE id = '${cam}'`);
    // Três trechos gravados 40–30 min atrás, com o do meio apagado por falta de movimento.
    execFileSync("docker", [
      "compose",
      "exec",
      "-T",
      "worker",
      "sh",
      "-c",
      `mkdir -p /recordings/cam/${cam} && touch /recordings/cam/${cam}/e2e-mov-a.mp4 /recordings/cam/${cam}/e2e-mov-c.mp4`,
    ]);
    psql(`UPDATE cameras SET recording_enabled = true, recording_mode = 'motion', motion_source = 'camera',
        retention_policy_id = coalesce(retention_policy_id, (SELECT id FROM retention_policies WHERE tenant_id IS NULL ORDER BY retention_hours LIMIT 1)) WHERE id = '${cam}';
      INSERT INTO recording_segments (tenant_id, camera_id, storage_node_id, path, started_at, ended_at, duration_ms, state, expires_at, deleted_reason, size_bytes)
      VALUES ('${tenant}', '${cam}', '${node}', 'cam/${cam}/e2e-mov-a.mp4', now() - interval '40 minutes', now() - interval '39 minutes', 60000, 'verified', now() + interval '1 day', NULL, 1),
             ('${tenant}', '${cam}', '${node}', 'cam/${cam}/e2e-mov-b.mp4', now() - interval '39 minutes', now() - interval '31 minutes', 480000, 'deleted', now(), 'no_motion', 1),
             ('${tenant}', '${cam}', '${node}', 'cam/${cam}/e2e-mov-c.mp4', now() - interval '31 minutes', now() - interval '30 minutes', 60000, 'verified', now() + interval '1 day', NULL, 1);
      INSERT INTO motion_events (tenant_id, camera_id, source, kind, started_at, ended_at, alarm_status)
      VALUES ('${tenant}', '${cam}', 'camera', 'human', now() - interval '39 minutes 40 seconds', now() - interval '39 minutes 20 seconds', 'disabled');`);
    try {
      await loginAdmin(page);
      await page.goto(`/gravacoes?camera=${cam}`);
      const tl = page.getByTestId("timeline");
      await expect(tl).toBeVisible({ timeout: 20_000 });
      await expect(tl.getByTestId("timeline-motion-legend")).toHaveText(/Movimento \(1\)/);
      await expect(tl.getByText("Sem gravação / sem movimento")).toBeVisible();
      await expect(tl.getByTestId("timeline-motion")).toHaveCount(1);
      await expect(tl.getByTestId("timeline-motion")).toHaveAttribute("title", /^Pessoa: /);
      // O trecho sem movimento (8 min) não aparece como lacuna de sinal.
      await expect(tl.getByText(/Lacuna de sinal \(0\)/)).toBeVisible();
      await page.screenshot({ path: "reports/screens/movimento-linha-do-tempo.png" });
    } finally {
      psql(`DELETE FROM motion_events WHERE camera_id = '${cam}';
        DELETE FROM recording_segments WHERE camera_id = '${cam}' AND path LIKE 'cam/${cam}/e2e-mov-%';
        UPDATE cameras SET recording_enabled = '${prev}'::boolean, recording_mode = 'continuous', motion_source = 'off' WHERE id = '${cam}';`);
      execFileSync("docker", [
        "compose",
        "exec",
        "-T",
        "worker",
        "sh",
        "-c",
        `rm -f /recordings/cam/${cam}/e2e-mov-*.mp4`,
      ]);
    }
  });
});
