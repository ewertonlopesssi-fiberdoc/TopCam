import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD } from "./helpers";

/**
 * App mobile (Fase 9.2) na versão web, contra o laboratório: foto das câmeras na lista,
 * mosaico de 1/4/9 com páginas e câmera ampliada, alarmes (abre a gravação no horário) e
 * gravações (calendário, linha do tempo com movimento, velocidades, reprodução).
 * Pré-requisito igual ao de app-mobile.spec.ts (app web em E2E_APP_URL).
 */

const APP = process.env.E2E_APP_URL ?? "http://localhost:8099";
const CODES = ["CAM-001", "CAM-002", "CAM-003", "CAM-004", "CAM-005"];
const dc = (...args: string[]) =>
  execFileSync("docker", ["compose", ...args], { encoding: "utf8" }).trim();
const psql = (q: string) =>
  dc("exec", "-T", "postgres", "psql", "-U", "topcam_owner", "-d", "topcam", "-Atq", "-c", q);
mkdirSync("reports/screens", { recursive: true });

async function adminToken(request: APIRequestContext) {
  const r = await request.post("/api/v1/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(r.ok()).toBe(true);
  return (await r.json()).accessToken as string;
}

test.describe("app mobile 9.2 (web)", () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) > 500, "só na largura de celular");
  test.setTimeout(240_000);

  const email = `app92-${Date.now().toString(36)}@alfa.test`;
  let userId = "";
  const cams: Record<string, string> = {};
  let prevRec = "";
  let prevRet = "";

  test.beforeAll(async ({ request }) => {
    test.setTimeout(300_000);
    const ok = await fetch(APP)
      .then((r) => r.ok)
      .catch(() => false);
    test.skip(!ok, `app web não está no ar em ${APP}`);
    const h = { authorization: `Bearer ${await adminToken(request)}` };
    const tenant = psql("SELECT id FROM tenants WHERE slug = 'empresa-alfa'");
    for (const code of CODES)
      cams[code] = psql(
        `SELECT id FROM cameras WHERE tenant_id = '${tenant}' AND code = '${code}' AND deleted_at IS NULL`,
      );
    prevRec = psql(`SELECT recording_enabled FROM cameras WHERE id = '${cams["CAM-001"]}'`);
    prevRet = psql(
      `SELECT coalesce(retention_policy_id::text, '') FROM cameras WHERE id = '${cams["CAM-001"]}'`,
    );
    psql(
      `UPDATE cameras SET recording_enabled = true, retention_policy_id = coalesce(retention_policy_id,
         (SELECT id FROM retention_policies WHERE tenant_id IS NULL ORDER BY retention_hours LIMIT 1))
        WHERE id = '${cams["CAM-001"]}';
       INSERT INTO durable_jobs (type, payload) VALUES ('mediamtx.reconcile', '{"reason":"e2e-app"}');`,
    );
    const u = await request.post("/api/v1/users", {
      headers: h,
      data: {
        name: "Síndico App",
        email,
        role: "viewer",
        tenantId: tenant,
        password: "SindicoApp9",
      },
    });
    expect(u.ok()).toBe(true);
    userId = (await u.json()).user.id;
    await request.put(`/api/v1/users/${userId}/camera-permissions`, {
      headers: h,
      data: {
        items: CODES.map((c) => ({
          cameraId: cams[c],
          canLive: true,
          canPlayback: c === "CAM-001",
          canExport: c === "CAM-001",
        })),
      },
    });
    for (const code of CODES) {
      const key = dc(
        "exec",
        "-T",
        "api",
        "node",
        "apps/api/dist/cli.js",
        "camera:show-key",
        "--tenant",
        "empresa-alfa",
        "--code",
        code,
        "--raw",
      );
      execFileSync("docker", ["rm", "-f", `topcam-tx92-${code}`], { stdio: "ignore" });
      dc(
        "--profile",
        "test",
        "run",
        "-d",
        "--rm",
        "--name",
        `topcam-tx92-${code}`,
        "test-transmitter",
        "publish",
        key,
        code,
      );
    }
    const ids = CODES.map((c) => `'${cams[c]}'`).join(",");
    await expect
      .poll(
        () =>
          psql(
            `SELECT count(*) FROM cameras WHERE id IN (${ids}) AND status IN ('ao_vivo', 'gravando')`,
          ),
        {
          timeout: 120_000,
        },
      )
      .toBe("5");
    // Primeiro segmento gravado conferido da CAM-001 e a foto de cada câmera.
    await expect
      .poll(
        () =>
          psql(
            `SELECT count(*) FROM recording_segments WHERE camera_id = '${cams["CAM-001"]}' AND state = 'verified' AND started_at > now() - interval '10 minutes'`,
          ),
        { timeout: 180_000, intervals: [5000] },
      )
      .not.toBe("0");
    await expect
      .poll(() => dc("exec", "-T", "api", "sh", "-c", "ls /snapshots | wc -l"), { timeout: 60_000 })
      .not.toBe("0");
    // Um alarme na CAM-001, no meio do último segmento gravado (que pode ser curto).
    psql(
      `INSERT INTO motion_events (tenant_id, camera_id, source, kind, started_at, ended_at, alarm_status)
       SELECT tenant_id, camera_id, 'camera', 'human', started_at + (ended_at - started_at) / 2, started_at + (ended_at - started_at) * 3 / 4, 'disabled'
         FROM recording_segments WHERE camera_id = '${cams["CAM-001"]}' AND state = 'verified' ORDER BY started_at DESC LIMIT 1`,
    );
  });

  test.afterAll(async ({ request }) => {
    for (const code of CODES)
      execFileSync("docker", ["rm", "-f", `topcam-tx92-${code}`], { stdio: "ignore" });
    if (cams["CAM-001"]) {
      psql(
        `DELETE FROM motion_events WHERE camera_id = '${cams["CAM-001"]}' AND source = 'camera' AND kind = 'human'`,
      );
      psql(
        `UPDATE cameras SET recording_enabled = '${prevRec || "f"}'::boolean,
           retention_policy_id = ${prevRet ? `'${prevRet}'` : "NULL"} WHERE id = '${cams["CAM-001"]}';
         INSERT INTO durable_jobs (type, payload) VALUES ('mediamtx.reconcile', '{"reason":"e2e-app-fim"}');`,
      );
    }
    if (userId) {
      const tok = await adminToken(request);
      await request.delete(`/api/v1/users/${userId}`, {
        headers: { authorization: `Bearer ${tok}` },
      });
    }
  });

  test("foto, mosaico 1/4/9 com câmera ampliada, alarmes e gravações", async ({ page }) => {
    let snaps = 0;
    let playback: { status: number; type: string } | null = null;
    page.on("response", (r) => {
      if (/\/api\/v1\/cameras\/[^/]+\/snapshot/.test(r.url()) && r.status() === 200) snaps++;
      if (/\/playback\/[^/]+\/get\?/.test(r.url()))
        playback = { status: r.status(), type: r.headers()["content-type"] ?? "" };
    });
    await page.goto(APP);
    await page.getByLabel("E-mail").fill(email);
    await page.getByLabel("Senha", { exact: true }).fill("SindicoApp9");
    await page.getByTestId("login-submit").click();

    // Lista com as 5 câmeras e a foto de cada uma.
    await expect(page.getByTestId("camera-row")).toHaveCount(5, { timeout: 15_000 });
    await expect.poll(() => snaps, { timeout: 20_000 }).toBeGreaterThanOrEqual(5);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: "reports/screens/app92-cameras.png" });

    // Mosaico: 4 por página (2 páginas), 9 numa só, 1 por página; ampliar e voltar.
    await page.getByRole("tab", { name: /Mosaico/ }).click();
    await expect(page.getByText("1 de 2")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid^="live-"]')).toHaveCount(4);
    await page.getByRole("button", { name: "Mosaico de 9" }).click();
    await expect(page.locator('[data-testid^="live-"]')).toHaveCount(5);
    await expect(page.getByText("1 de 2")).toHaveCount(0);
    await page.screenshot({ path: "reports/screens/app92-mosaico9.png" });
    await page.getByRole("button", { name: "Mosaico de 1" }).click();
    await expect(page.getByText("1 de 5")).toBeVisible();
    await page.getByRole("button", { name: "Mosaico de 4" }).click();
    await page.getByTestId(`live-${cams["CAM-002"]}`).click();
    await expect(page.getByRole("button", { name: "Voltar ao mosaico" })).toBeVisible();
    await expect(page.locator('[data-testid^="live-"]')).toHaveCount(1);
    await page.screenshot({ path: "reports/screens/app92-ampliada.png" });
    await page.getByRole("button", { name: "Voltar ao mosaico" }).click();
    await expect(page.locator('[data-testid^="live-"]')).toHaveCount(4);

    // Alarmes: o movimento aparece e abre a gravação no horário.
    await page.getByRole("tab", { name: /Alarmes/ }).click();
    // Fora da aba Mosaico os vídeos param.
    await expect(page.locator('[data-testid^="live-"]')).toHaveCount(0);
    const alarm = page.getByTestId("alarm-row").first();
    await expect(alarm).toBeVisible({ timeout: 15_000 });
    await expect(alarm).toContainText("Pessoa detectada");
    await expect(alarm).toContainText("Ver gravação");
    await page.screenshot({ path: "reports/screens/app92-alarmes.png" });
    await alarm.click();

    // Gravações: linha do tempo com o movimento, reprodução pedida ao servidor, velocidades.
    await expect(page.getByTestId("app-timeline")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("app-timeline-motion").first()).toBeVisible();
    await expect.poll(() => playback, { timeout: 20_000 }).not.toBeNull();
    expect(playback!.status).toBe(200);
    expect(playback!.type).toContain("video/mp4");
    await page.getByRole("button", { name: "Velocidade 8x" }).click();
    // A velocidade vai para o player.
    await expect
      .poll(() =>
        page.evaluate(() =>
          Math.max(0, ...Array.from(document.querySelectorAll("video")).map((v) => v.playbackRate)),
        ),
      )
      .toBe(8);
    await page.getByRole("button", { name: "Escolher dia" }).click();
    await expect(page.getByRole("button", { name: /, com gravação/ }).first()).toBeVisible();
    await page.screenshot({ path: "reports/screens/app92-gravacoes.png", fullPage: true });

    // Baixar trecho (0.2.2): marca o início na linha do tempo, confere Das/Às e baixa.
    await page.getByRole("button", { name: "Marcar início aqui" }).click();
    await expect(page.getByTestId("dl-marked")).toContainText("Trecho: das");
    await page.getByRole("button", { name: "Baixar trecho" }).click();
    await expect(page.getByLabel("Das hora", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Às minuto", { exact: true })).toBeVisible();
    await expect(page.getByTestId("dl-check")).not.toContainText("precisa");
    await page.screenshot({ path: "reports/screens/app92-baixar-trecho.png" });
    const exp = page.waitForResponse(
      (r) => r.url().includes("/exports") && r.request().method() === "POST",
    );
    page.context().once("page", (p) => void p.close().catch(() => undefined));
    await page.getByRole("button", { name: "Baixar", exact: true }).click();
    const er = await exp;
    expect(er.status()).toBe(200);
    const body = (await er.json()) as { seconds: number; recordedSeconds: number };
    expect(body.seconds).toBeGreaterThan(0);
    expect(body.seconds).toBeLessThanOrEqual(300);
    expect(body.recordedSeconds).toBeGreaterThan(0);
    const sent = JSON.parse(er.request().postData() ?? "{}") as { start: string; end: string };
    expect(Date.parse(sent.end)).toBeGreaterThan(Date.parse(sent.start));
    // Fim antes do início: o app avisa e não pede ao servidor.
    await page.getByRole("button", { name: "Baixar trecho" }).click();
    await page.getByLabel("Às hora", { exact: true }).fill("00");
    await page.getByLabel("Às hora", { exact: true }).press("Tab");
    await expect(page.getByTestId("dl-check")).toContainText("O fim precisa ser depois do início");
    await page.getByRole("button", { name: "Cancelar" }).click();

    // Câmera que grava e com "pode reproduzir": botão na lista e no ao vivo.
    await page.goto(APP);
    await expect(page.getByRole("button", { name: "Gravações de Entrada Principal" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("button", { name: "Gravações de Estacionamento" })).toHaveCount(0);
    await page.getByRole("button", { name: /Entrada Principal, CAM-001/ }).click();
    await expect(page.getByRole("button", { name: "Gravações" })).toBeVisible();
    await page.getByRole("button", { name: "Gravações" }).click();
    await expect(page.getByTestId("app-timeline")).toBeVisible({ timeout: 20_000 });

    // Câmera sem "pode reproduzir": o ao vivo não oferece Gravações.
    await page.goto(APP);
    await page.getByRole("button", { name: /CAM-002/ }).click();
    await expect(page.getByRole("button", { name: "Ligar som" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Gravações" })).toHaveCount(0);
  });
});
