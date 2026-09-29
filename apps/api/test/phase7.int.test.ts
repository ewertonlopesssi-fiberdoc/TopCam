import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createPool, type Pool } from "@topcam/db";
import { decryptSecret, parseEncryptionKey, type MediaMtxClient } from "@topcam/shared";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { SMTPServer } from "smtp-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  REDIS_URL,
  createTestDb,
  ownerQuery,
  type TestDb,
} from "../../../packages/db/test/helpers.js";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";

/**
 * Monitoramento (Fase 7): integração de e-mail (SMTP real local, com senha), alertas
 * (reconhecer/resolver), eventos, dashboard e relatório de disponibilidade — com o
 * isolamento por cliente e por câmera concedida.
 */

let db: TestDb;
let pool: Pool;
let redis: Redis;
let app: FastifyInstance;
let smtp: SMTPServer;
let smtpPort = 0;
const inbox: string[] = [];

beforeAll(async () => {
  smtp = new SMTPServer({
    disabledCommands: ["STARTTLS"],
    onAuth(auth, _s, cb) {
      if (auth.username === "topcam@teste.local" && auth.password === "abcd efgh ijkl mnop")
        return cb(null, { user: auth.username });
      return cb(new Error("535 5.7.8 Username and Password not accepted"));
    },
    onData(stream, _s, cb) {
      let raw = "";
      stream.on("data", (d: Buffer) => (raw += d.toString()));
      stream.on("end", () => {
        inbox.push(raw);
        cb();
      });
    },
  });
  await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r));
  smtpPort = (smtp.server.address() as AddressInfo).port;
  db = await createTestDb();
  pool = createPool(db.appUrl, 4);
  redis = new Redis(REDIS_URL);
  await redis.flushdb();
  app = await buildApp({
    env: loadEnv({
      DATABASE_URL: db.appUrl,
      REDIS_URL,
      MEDIA_HOOK_SECRET: randomBytes(24).toString("hex"),
      MEDIA_READ_PASSWORD: randomBytes(16).toString("hex"),
      MEDIA_GATEWAY_TOKEN: "gateway-token-de-teste-1234567890",
      STREAM_KEY_ENC_KEY: db.encKeyB64,
      JWT_SECRET: randomBytes(32).toString("hex"),
      LOG_LEVEL: "silent",
    }),
    pool,
    redis,
    mediamtx: { listPaths: async () => [], getPath: async () => null } as unknown as MediaMtxClient,
  });
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  redis?.disconnect();
  await db?.drop();
  await new Promise<void>((r) => smtp?.close(() => r()));
});

async function login(email: string, password: string) {
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password },
  });
  return r.json().accessToken as string;
}
function api(token: string) {
  const call = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      payload: payload as object,
      headers: { authorization: `Bearer ${token}` },
    });
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
    put: (u: string, p: unknown) => call("PUT", u, p),
  };
}
async function activate(email: string, temp: string, next: string) {
  const t = await login(email, temp);
  await api(t).post("/api/v1/auth/change-password", { currentPassword: temp, newPassword: next });
  return login(email, next);
}

let admin = "";
let alfaAdmin = "";
let solAdmin = "";
let viewer = "";
let alfa = "";
let sol = "";
let cam1 = "";
let cam2 = "";
let solCam = "";

const smtpBody = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  host: "127.0.0.1",
  port: smtpPort,
  security: "none",
  username: "topcam@teste.local",
  password: "abcd efgh ijkl mnop",
  fromName: "TopCam Alertas",
  fromEmail: "topcam@teste.local",
  recipients: "noc@teste.local, Suporte@Teste.local",
  minSeverity: "error",
  notifyResolved: true,
  ...over,
});

beforeAll(async () => {
  admin = await activate("admin@test.local", "senha-de-teste-123", "NovaSenhaForte2026");
  const cams = await ownerQuery<{ id: string; code: string; tenant_id: string; slug: string }>(
    db,
    `SELECT c.id, c.code, c.tenant_id, t.slug FROM cameras c JOIN tenants t ON t.id = c.tenant_id ORDER BY t.slug, c.code`,
  );
  const a = cams.filter((c) => c.slug === "empresa-alfa");
  alfa = a[0]!.tenant_id;
  cam1 = a.find((c) => c.code === "CAM-001")!.id;
  cam2 = a.find((c) => c.code === "CAM-002")!.id;
  const s = cams.find((c) => c.slug === "condominio-sol")!;
  sol = s.tenant_id;
  solCam = s.id;
  const mk = async (email: string, role: string, tenantId: string, pass: string) => {
    const r = (
      await api(admin).post("/api/v1/users", { name: email, email, role, tenantId })
    ).json();
    return { id: r.user.id as string, token: await activate(email, r.temporaryPassword, pass) };
  };
  alfaAdmin = (await mk("gestor@alfa.test", "tenant_admin", alfa, "Cliente-Alfa-2026x")).token;
  solAdmin = (await mk("gestor@sol.test", "tenant_admin", sol, "Cliente-Sol-2026x")).token;
  const v = await mk("vigia@alfa.test", "viewer", alfa, "Portaria-Alfa-2026x");
  viewer = v.token;
  await api(admin).put(`/api/v1/users/${v.id}/camera-permissions`, {
    items: [{ cameraId: cam1, canLive: true }],
  });

  // Alertas: CAM-001 e CAM-002 (Alfa), câmera do Sol e um da plataforma (disco).
  const ins = (
    rule: string,
    sev: string,
    title: string,
    tenant: string | null,
    cam: string | null,
  ) =>
    ownerQuery(
      db,
      `INSERT INTO alerts (rule, severity, title, dedup_key, tenant_id, camera_id) VALUES ($1, $2, $3, $4, $5, $6)`,
      [rule, sev, title, `${rule}:${title}`, tenant, cam],
    );
  await ins("camera_offline", "error", "Alfa CAM-001 sem sinal", alfa, cam1);
  await ins("camera_offline", "error", "Alfa CAM-002 sem sinal", alfa, cam2);
  await ins("camera_offline", "critical", "Sol CAM-001 sem sinal", sol, solCam);
  await ins("storage_level", "warning", "Disco em 72%", null, null);
  for (const [tenant, cam, msg] of [
    [alfa, cam1, "evento alfa 1"],
    [alfa, cam2, "evento alfa 2"],
    [sol, solCam, "evento sol"],
    [null, null, "evento plataforma"],
  ] as const)
    await ownerQuery(
      db,
      `INSERT INTO camera_events (tenant_id, camera_id, type, severity, message) VALUES ($1, $2, 'stream_offline', 'warning', $3)`,
      [tenant, cam, msg],
    );
});

describe("integrações: e-mail (SMTP)", () => {
  it("só o Super Admin vê e altera", async () => {
    expect((await api(alfaAdmin).get("/api/v1/integrations")).statusCode).toBe(403);
    expect((await api(alfaAdmin).put("/api/v1/integrations/smtp", smtpBody())).statusCode).toBe(
      403,
    );
    const g = (await api(admin).get("/api/v1/integrations")).json();
    expect(g.smtp).toMatchObject({
      enabled: false,
      host: "smtp.gmail.com",
      port: 587,
      security: "starttls",
      hasPassword: false,
    });
  });

  it("valida os campos antes de ligar", async () => {
    const a = api(admin);
    expect(
      (await a.put("/api/v1/integrations/smtp", smtpBody({ recipients: "" }))).statusCode,
    ).toBe(400);
    expect(
      (await a.put("/api/v1/integrations/smtp", smtpBody({ recipients: "nao-e-email" })))
        .statusCode,
    ).toBe(400);
    expect(
      (await a.put("/api/v1/integrations/smtp", smtpBody({ password: undefined }))).statusCode,
    ).toBe(400);
    expect((await a.put("/api/v1/integrations/smtp", smtpBody({ port: 0 }))).statusCode).toBe(400);
  });

  it("senha cifrada, nunca devolvida nem auditada; em branco mantém a salva", async () => {
    const a = api(admin);
    expect((await a.put("/api/v1/integrations/smtp", smtpBody())).statusCode).toBe(200);
    const g = (await a.get("/api/v1/integrations")).json();
    expect(g.smtp).toMatchObject({
      enabled: true,
      hasPassword: true,
      recipients: ["noc@teste.local", "suporte@teste.local"],
    });
    expect(JSON.stringify(g)).not.toContain("abcd efgh");
    const [row] = await ownerQuery<{ value: { password_enc: string } }>(
      db,
      "SELECT value FROM system_settings WHERE key = 'integrations.smtp'",
    );
    expect(row!.value.password_enc).not.toContain("abcd");
    expect(decryptSecret(row!.value.password_enc, parseEncryptionKey(db.encKeyB64))).toBe(
      "abcd efgh ijkl mnop",
    );
    expect(
      (
        await a.put(
          "/api/v1/integrations/smtp",
          smtpBody({ password: undefined, fromName: "Outro" }),
        )
      ).statusCode,
    ).toBe(200);
    const [row2] = await ownerQuery<{ value: { password_enc: string } }>(
      db,
      "SELECT value FROM system_settings WHERE key = 'integrations.smtp'",
    );
    expect(row2!.value.password_enc).toBe(row!.value.password_enc);
    const audits = await ownerQuery<{ data: Record<string, unknown> }>(
      db,
      "SELECT data FROM audit_logs WHERE action = 'integrations.smtp_updated' ORDER BY id",
    );
    expect(audits.map((x) => x.data.passwordChanged)).toEqual([true, false]);
    expect(JSON.stringify(audits)).not.toContain("abcd");
  });

  it("e-mail de teste chega ao servidor; senha errada dá mensagem clara (senha de app)", async () => {
    const a = api(admin);
    await a.put("/api/v1/integrations/smtp", smtpBody());
    const ok = await a.post("/api/v1/integrations/smtp/test", { to: "eu@teste.local" });
    expect(ok.statusCode).toBe(200);
    expect(inbox.at(-1)).toContain("E-mail de teste");
    expect(inbox.at(-1)).toContain("From: TopCam Alertas <topcam@teste.local>");
    await a.put("/api/v1/integrations/smtp", smtpBody({ password: "senha-errada" }));
    const bad = await a.post("/api/v1/integrations/smtp/test", {});
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toContain("senha de app");
    const g = (await a.get("/api/v1/integrations")).json();
    expect(g.notifications.slice(0, 2).map((n: { status: string }) => n.status)).toEqual([
      "failed",
      "sent",
    ]);
  });
});

describe("alertas", () => {
  const titles = async (token: string, q = "") =>
    (
      (await api(token).get(`/api/v1/alerts?pageSize=50${q}`)).json().items as Array<{
        title: string;
      }>
    )
      .map((x) => x.title)
      .sort();

  it("cada um vê o que é seu: plataforma tudo; cliente o seu; visualizador só a câmera concedida", async () => {
    expect(await titles(admin)).toHaveLength(4);
    expect(await titles(alfaAdmin)).toEqual(["Alfa CAM-001 sem sinal", "Alfa CAM-002 sem sinal"]);
    expect(await titles(solAdmin)).toEqual(["Sol CAM-001 sem sinal"]);
    expect(await titles(viewer)).toEqual(["Alfa CAM-001 sem sinal"]);
    expect((await api(viewer).get("/api/v1/alerts/summary")).json()).toMatchObject({
      total: 1,
      bySeverity: { error: 1 },
    });
    expect((await api(alfaAdmin).get(`/api/v1/alerts?tenantId=${sol}`)).statusCode).toBe(403);
  });

  it("reconhecer e resolver: cliente só os seus; visualizador não; auditado", async () => {
    const list = (await api(alfaAdmin).get("/api/v1/alerts")).json().items as Array<{
      id: string;
      title: string;
    }>;
    const a1 = list.find((x) => x.title.includes("CAM-001"))!;
    const solId = (
      (await api(admin).get(`/api/v1/alerts?tenantId=${sol}`)).json().items[0] as { id: string }
    ).id;
    expect((await api(viewer).post(`/api/v1/alerts/${a1.id}/ack`)).statusCode).toBe(403);
    expect((await api(alfaAdmin).post(`/api/v1/alerts/${solId}/ack`)).statusCode).toBe(404);
    expect((await api(alfaAdmin).post(`/api/v1/alerts/${a1.id}/ack`)).statusCode).toBe(200);
    const ack = (await api(admin).get("/api/v1/alerts?status=acknowledged")).json().items;
    expect(ack).toMatchObject([
      { title: "Alfa CAM-001 sem sinal", acknowledgedBy: "gestor@alfa.test" },
    ]);
    expect((await api(alfaAdmin).post(`/api/v1/alerts/${a1.id}/resolve`)).statusCode).toBe(200);
    expect((await api(alfaAdmin).post(`/api/v1/alerts/${a1.id}/resolve`)).statusCode).toBe(400);
    expect(await titles(alfaAdmin)).toEqual(["Alfa CAM-002 sem sinal"]);
    expect(await titles(alfaAdmin, "&status=resolved")).toEqual(["Alfa CAM-001 sem sinal"]);
    const aud = await ownerQuery<{ action: string }>(
      db,
      "SELECT action FROM audit_logs WHERE action LIKE 'alert.%' ORDER BY id",
    );
    expect(aud.map((x) => x.action)).toEqual(["alert.acknowledged", "alert.resolved"]);
  });
});

describe("eventos", () => {
  it("filtros e isolamento (visualizador só a câmera concedida; sem eventos do sistema)", async () => {
    const msgs = async (t: string, q = "") =>
      (
        (await api(t).get(`/api/v1/events?type=stream_offline${q}`)).json().items as Array<{
          message: string;
        }>
      )
        .map((e) => e.message)
        .sort();
    expect(await msgs(admin)).toEqual([
      "evento alfa 1",
      "evento alfa 2",
      "evento plataforma",
      "evento sol",
    ]);
    expect(await msgs(alfaAdmin)).toEqual(["evento alfa 1", "evento alfa 2"]);
    expect(await msgs(viewer)).toEqual(["evento alfa 1"]);
    expect(await msgs(admin, `&cameraId=${solCam}`)).toEqual(["evento sol"]);
    expect(await msgs(admin, "&q=plataforma")).toEqual(["evento plataforma"]);
  });
});

describe("dashboard", () => {
  it("números, alertas e eventos no escopo de cada um", async () => {
    await ownerQuery(db, "UPDATE cameras SET status = 'gravando' WHERE id = $1", [cam1]);
    await ownerQuery(db, "UPDATE cameras SET status = 'offline' WHERE id = $1", [cam2]);
    await ownerQuery(
      db,
      `INSERT INTO status_samples (tenant_id, cameras, online, recording, offline, ingress_bps) VALUES
         (NULL, 6, 3, 1, 1, 4000000), ($1, 5, 2, 1, 1, NULL)`,
      [alfa],
    );
    const p = (await api(admin).get("/api/v1/dashboard")).json();
    expect(p.tenants).toBeGreaterThanOrEqual(2);
    expect(p.storage).toHaveLength(1);
    expect(p.samples.at(-1)).toMatchObject({ cameras: 6, online: 3, ingressBps: 4000000 });
    const t = (await api(alfaAdmin).get("/api/v1/dashboard")).json();
    expect(t.cameras).toMatchObject({ total: 5, recording: 1, offline: 1 });
    expect(t.tenants).toBeUndefined();
    expect(t.samples.at(-1)).toMatchObject({ cameras: 5, online: 2 });
    const v = (await api(viewer).get("/api/v1/dashboard")).json();
    expect(v.cameras).toMatchObject({ total: 1, recording: 1 });
    expect(v.samples).toEqual([]);
  });
});

describe("relatórios", () => {
  it("disponibilidade e gravação por câmera, CSV em português; cliente só o seu; visualizador não", async () => {
    const hour = "2026-09-28T10:00:00Z";
    await ownerQuery(
      db,
      `INSERT INTO camera_hourly (camera_id, tenant_id, hour, observed_s, online_s, recording_s) VALUES
         ($1, $3, $4, 3600, 3240, 3000), ($2, $3, $4, 3600, 1800, 0)`,
      [cam1, cam2, alfa, hour],
    );
    await ownerQuery(db, "UPDATE cameras SET recording_enabled = true WHERE id = $1", [cam1]);
    const q = "from=2026-09-28T00:00:00Z&to=2026-09-29T00:00:00Z";
    const r = (await api(alfaAdmin).get(`/api/v1/reports/availability?${q}`)).json();
    const c1 = r.items.find((i: { cameraId: string }) => i.cameraId === cam1);
    expect(c1).toMatchObject({ availabilityPct: 90, recordingPct: 83.3, onlineS: 3240 });
    expect(r.items.find((i: { cameraId: string }) => i.cameraId === cam2).availabilityPct).toBe(50);
    expect(r.items.every((i: { tenantName: string }) => i.tenantName === "Empresa Alfa")).toBe(
      true,
    );
    expect(
      (await api(alfaAdmin).get(`/api/v1/reports/availability?${q}&tenantId=${sol}`)).statusCode,
    ).toBe(403);
    expect((await api(viewer).get(`/api/v1/reports/availability?${q}`)).statusCode).toBe(403);
    const csv = await api(admin).get(
      `/api/v1/reports/availability?${q}&tenantId=${alfa}&format=csv`,
    );
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["content-disposition"]).toContain(
      "disponibilidade_2026-09-28_2026-09-29.csv",
    );
    const lines = csv.body.replace(/^\uFEFF/, "").split("\r\n");
    expect(lines[0]).toContain("Cliente;Câmera;Nome;Disponibilidade (%)");
    expect(lines.find((l) => l.includes(";CAM-001;"))).toContain(";90,0;1,0;0,9;83,3;");
    expect(
      (await api(admin).get("/api/v1/reports/availability?from=2026-09-29&to=2026-09-28"))
        .statusCode,
    ).toBe(400);
  });
});
