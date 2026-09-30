import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createPool, type Pool } from "@topcam/db";
import { generateTempPassword, validatePassword, type MediaMtxClient } from "@topcam/shared";
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
 * Cadastro de usuários: senha digitada pelo administrador (ou gerada), troca obrigatória
 * opcional, alteração de senha e envio de usuário e senha por e-mail (SMTP real local).
 * Política: mínimo 8 caracteres, 1 maiúscula, 1 minúscula e 1 número.
 */

let db: TestDb;
let pool: Pool;
let redis: Redis;
let app: FastifyInstance;
let smtp: SMTPServer;
let smtpPort = 0;
const inbox: Array<{ to: string; body: string }> = [];

beforeAll(async () => {
  smtp = new SMTPServer({
    disabledCommands: ["STARTTLS"],
    authOptional: true,
    onData(stream, session, cb) {
      let raw = "";
      stream.on("data", (d: Buffer) => (raw += d.toString()));
      stream.on("end", () => {
        inbox.push({
          to: session.envelope.rcptTo.map((r) => r.address).join(","),
          body: Buffer.from(
            raw
              .replace(/=\r?\n/g, "")
              .replace(/=([0-9A-F]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))),
            "latin1",
          ).toString("utf8"),
        });
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
      PANEL_URL: "http://painel.teste",
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

async function loginRaw(email: string, password: string) {
  return app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password },
  });
}
async function login(email: string, password: string) {
  return (await loginRaw(email, password)).json().accessToken as string;
}
function api(token: string) {
  const call = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: unknown) =>
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
    patch: (u: string, p: unknown) => call("PATCH", u, p),
  };
}

let admin = "";
let alfa = "";

beforeAll(async () => {
  const t = await login("admin@test.local", "senha-de-teste-123");
  await api(t).post("/api/v1/auth/change-password", {
    currentPassword: "senha-de-teste-123",
    newPassword: "NovaSenha2026",
  });
  admin = await login("admin@test.local", "NovaSenha2026");
  alfa = (
    await ownerQuery<{ id: string }>(db, "SELECT id FROM tenants WHERE slug = 'empresa-alfa'")
  )[0]!.id;
});

const smtpOn = () =>
  api(admin).put("/api/v1/integrations/smtp", {
    enabled: true,
    host: "127.0.0.1",
    port: smtpPort,
    security: "none",
    username: "",
    fromName: "TopCam",
    fromEmail: "topcam@teste.local",
    recipients: "noc@teste.local",
    minSeverity: "error",
    notifyResolved: true,
  });

describe("política de senha", () => {
  it("mínimo 8, com maiúscula, minúscula e número (sem a regra do e-mail)", () => {
    expect(validatePassword("Abcdef12")).toBeNull();
    expect(validatePassword("Abc12")).toMatch(/8 caracteres/);
    expect(validatePassword("abcdefg1")).toMatch(/maiúscula/);
    expect(validatePassword("ABCDEFG1")).toMatch(/minúscula/);
    expect(validatePassword("Abcdefgh")).toMatch(/número/);
    expect(validatePassword("Joao2026x", "joao@x.com")).toBeNull();
    for (let i = 0; i < 200; i++) expect(validatePassword(generateTempPassword())).toBeNull();
  });

  it("troca pelo próprio usuário segue a mesma regra", async () => {
    const r = (
      await api(admin).post("/api/v1/users", {
        name: "Regra",
        email: "regra@alfa.test",
        role: "viewer",
        tenantId: alfa,
        password: "Inicial2026",
        mustChangePassword: true,
      })
    ).json();
    expect(r.temporaryPassword).toBeUndefined();
    const t = await login("regra@alfa.test", "Inicial2026");
    const weak = await api(t).post("/api/v1/auth/change-password", {
      currentPassword: "Inicial2026",
      newPassword: "semmaiuscula1",
    });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().message).toMatch(/maiúscula/);
    const ok = await api(t).post("/api/v1/auth/change-password", {
      currentPassword: "Inicial2026",
      newPassword: "Regra2026",
    });
    expect(ok.statusCode).toBe(200);
  });
});

describe("senha no cadastro", () => {
  it("senha digitada: entra direto, sem troca obrigatória e sem senha na resposta", async () => {
    const r = await api(admin).post("/api/v1/users", {
      name: "Maria Silva",
      email: "maria@alfa.test",
      role: "viewer",
      tenantId: alfa,
      password: "Maria2026",
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().temporaryPassword).toBeUndefined();
    expect(r.json().mustChangePassword).toBe(false);
    const t = await login("maria@alfa.test", "Maria2026");
    const me = await api(t).get("/api/v1/auth/me");
    expect(me.json().mustChangePassword).toBe(false);
    // Auditoria sem a senha.
    const aud = await ownerQuery<{ data: unknown }>(
      db,
      "SELECT data FROM audit_logs WHERE action = 'user.created' AND entity_id = $1",
      [r.json().user.id],
    );
    expect(JSON.stringify(aud)).not.toContain("Maria2026");
    expect(JSON.stringify(aud)).toContain("definida pelo administrador");
  });

  it("senha fraca é recusada com a mensagem da regra", async () => {
    const r = await api(admin).post("/api/v1/users", {
      name: "Fraca",
      email: "fraca@alfa.test",
      role: "viewer",
      tenantId: alfa,
      password: "fraca123",
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().message).toMatch(/maiúscula/);
  });

  it("sem senha: gera temporária com troca obrigatória (como antes)", async () => {
    const r = await api(admin).post("/api/v1/users", {
      name: "Gerada",
      email: "gerada@alfa.test",
      role: "viewer",
      tenantId: alfa,
    });
    expect(r.statusCode).toBe(201);
    expect(validatePassword(r.json().temporaryPassword)).toBeNull();
    expect(r.json().mustChangePassword).toBe(true);
  });

  it("alterar a senha na edição encerra as sessões do usuário", async () => {
    const id = (
      await ownerQuery<{ id: string }>(db, "SELECT id FROM users WHERE email = 'maria@alfa.test'")
    )[0]!.id;
    const old = await login("maria@alfa.test", "Maria2026");
    const r = await api(admin).patch(`/api/v1/users/${id}`, {
      password: "Maria2027",
      mustChangePassword: true,
    });
    expect(r.statusCode).toBe(200);
    expect((await api(old).get("/api/v1/auth/me")).statusCode).toBe(401);
    expect((await loginRaw("maria@alfa.test", "Maria2026")).statusCode).toBe(401);
    const t = await login("maria@alfa.test", "Maria2027");
    expect((await api(t).get("/api/v1/auth/me")).json().mustChangePassword).toBe(true);
  });

  it("o administrador não troca a própria senha pelo cadastro", async () => {
    const me = (await api(admin).get("/api/v1/auth/me")).json().id;
    expect(
      (await api(admin).patch(`/api/v1/users/${me}`, { password: "Outra2026x" })).statusCode,
    ).toBe(403);
    expect((await api(admin).post(`/api/v1/users/${me}/reset-password`, {})).statusCode).toBe(403);
  });
});

describe("envio de usuário e senha por e-mail", () => {
  it("sem e-mail configurado: salva a senha e informa que não enviou", async () => {
    expect((await api(admin).get("/api/v1/users/mail-status")).json().enabled).toBe(false);
    const r = await api(admin).post("/api/v1/users", {
      name: "Sem Email",
      email: "semmail@alfa.test",
      role: "viewer",
      tenantId: alfa,
      password: "SemMail2026",
      sendEmail: true,
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().mail).toMatchObject({ sent: false });
    expect(r.json().mail.error).toMatch(/Integrações/);
    expect((await loginRaw("semmail@alfa.test", "SemMail2026")).statusCode).toBe(200);
  });

  it("cadastro com envio: o e-mail leva endereço, usuário e senha", async () => {
    expect((await smtpOn()).statusCode).toBe(200);
    expect((await api(admin).get("/api/v1/users/mail-status")).json().enabled).toBe(true);
    inbox.length = 0;
    const r = await api(admin).post("/api/v1/users", {
      name: "João Vizinho",
      email: "joao@alfa.test",
      role: "viewer",
      tenantId: alfa,
      password: "Joao2026x",
      sendEmail: true,
    });
    expect(r.json().mail).toEqual({ sent: true, error: null });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.to).toBe("joao@alfa.test");
    expect(inbox[0]!.body).toContain("Usuário: joao@alfa.test");
    expect(inbox[0]!.body).toContain("Senha: Joao2026x");
    expect(inbox[0]!.body).toContain("http://painel.teste");
    // Registro de envio sem a senha; auditoria do envio.
    const n = await ownerQuery<{ kind: string; status: string; subject: string }>(
      db,
      "SELECT kind, status, subject FROM notifications WHERE recipients = 'joao@alfa.test'",
    );
    expect(n).toEqual([
      { kind: "access", status: "sent", subject: "[TopCam] Seus dados de acesso" },
    ]);
    expect(JSON.stringify(n)).not.toContain("Joao2026x");
    const aud = await ownerQuery<{ n: number }>(
      db,
      "SELECT count(*)::int AS n FROM audit_logs WHERE action = 'user.access_emailed' AND data::text NOT LIKE '%Joao2026x%'",
    );
    expect(aud[0]!.n).toBeGreaterThanOrEqual(1);
  });

  it("enviar acesso pela lista gera nova senha, envia e não a devolve só se foi digitada", async () => {
    const id = (
      await ownerQuery<{ id: string }>(db, "SELECT id FROM users WHERE email = 'joao@alfa.test'")
    )[0]!.id;
    inbox.length = 0;
    const r = await api(admin).post(`/api/v1/users/${id}/reset-password`, { sendEmail: true });
    expect(r.statusCode).toBe(200);
    const temp = r.json().temporaryPassword as string;
    expect(validatePassword(temp)).toBeNull();
    expect(r.json().mustChangePassword).toBe(true);
    expect(r.json().mail.sent).toBe(true);
    expect(inbox[0]!.body).toContain(`Senha: ${temp}`);
    expect(inbox[0]!.body).toContain("primeiro acesso");
    expect((await loginRaw("joao@alfa.test", temp)).statusCode).toBe(200);
  });

  it("admin de cliente usa as mesmas opções só no próprio cliente", async () => {
    const g = (
      await api(admin).post("/api/v1/users", {
        name: "Gestor",
        email: "gestor@alfa.test",
        role: "tenant_admin",
        tenantId: alfa,
        password: "Gestor2026",
      })
    ).json();
    const gt = await login("gestor@alfa.test", "Gestor2026");
    const r = await api(gt).post("/api/v1/users", {
      name: "Parente",
      email: "parente@alfa.test",
      role: "viewer",
      password: "Parente2026",
      sendEmail: true,
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().mail.sent).toBe(true);
    const solTenant = (
      await ownerQuery<{ id: string }>(db, "SELECT id FROM tenants WHERE slug = 'condominio-sol'")
    )[0]!.id;
    const other = (
      await api(admin).post("/api/v1/users", {
        name: "Morador Sol",
        email: "morador@sol.test",
        role: "viewer",
        tenantId: solTenant,
        password: "Morador2026",
      })
    ).json().user.id as string;
    expect(
      (await api(gt).post(`/api/v1/users/${other}/reset-password`, { sendEmail: true })).statusCode,
    ).toBe(404);
    expect(
      (await api(gt).patch(`/api/v1/users/${other}`, { password: "Invasao2026" })).statusCode,
    ).toBe(404);
    expect((await loginRaw("morador@sol.test", "Morador2026")).statusCode).toBe(200);
    expect(g.user.id).toBeTruthy();
  });
});
