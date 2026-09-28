import { defineConfig } from "@playwright/test";

/**
 * Testes de ponta a ponta do painel (Fase 2), contra o ambiente do Compose.
 *   E2E_BASE_URL (padrão http://localhost), E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD (senha inicial do .env)
 * Três larguras: computador (1440), tablet (768) e celular (390).
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  outputDir: "reports/e2e-output",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost",
    locale: "pt-BR",
    timezoneId: "America/Sao_Paulo",
    screenshot: "only-on-failure",
    launchOptions: process.env.PW_CHROMIUM_PATH
      ? { executablePath: process.env.PW_CHROMIUM_PATH }
      : {},
  },
  projects: [
    { name: "computador", use: { viewport: { width: 1440, height: 900 } } },
    { name: "tablet", use: { viewport: { width: 768, height: 1024 }, hasTouch: true } },
    {
      name: "celular",
      use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
    },
  ],
});
