import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPool, type Pool } from "@topcam/db";
import type { MediaMtxClient } from "@topcam/shared";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
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
 * Backup (Fase 8, parte 3): configuração pelo painel, segredos cifrados e nunca devolvidos,
 * pedidos para o serviço de backup (um por vez), identidade SFTP e auditoria sem segredos.
 */

let db: TestDb;
let pool: Pool;
let redis: Redis;
let app: FastifyInstance;

const BACKUP_DIR = mkdtempSync(join(tmpdir(), "topcam-bkp-api-"));

beforeAll(async () => {
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
      BACKUP_DIR,
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
  rmSync(BACKUP_DIR, { recursive: true, force: true });
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
  const call = (
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    payload?: unknown,
  ) =>
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
    del: (u: string) => call("DELETE", u),
  };
}

let admin = "";
let alfaAdmin = "";

beforeAll(async () => {
  const t = await login("admin@test.local", "senha-de-teste-123");
  await api(t).post("/api/v1/auth/change-password", {
    currentPassword: "senha-de-teste-123",
    newPassword: "NovaSenha2026",
  });
  admin = await login("admin@test.local", "NovaSenha2026");
  const alfa = (
    await ownerQuery<{ id: string }>(db, "SELECT id FROM tenants WHERE slug = 'empresa-alfa'")
  )[0]!.id;
  await api(admin).post("/api/v1/users", {
    name: "Gestor",
    email: "gestor@alfa.test",
    role: "tenant_admin",
    tenantId: alfa,
    password: "GestorAlfa1",
  });
  alfaAdmin = await login("gestor@alfa.test", "GestorAlfa1");
});

const S = "/api/v1/backup/settings";
const base = {
  enabled: false,
  protocol: "sftp",
  host: "backup.teste",
  username: "bkp",
  path: "topcam-backups",
  scheduleTime: "03:30",
  retentionRemote: 14,
  retentionLocal: 3,
};

describe("backup: configuração e pedidos", () => {
  it("cliente não vê nem altera o backup", async () => {
    expect((await api(alfaAdmin).get("/api/v1/backup")).statusCode).toBe(403);
    expect((await api(alfaAdmin).put(S, base)).statusCode).toBe(403);
    expect((await api(alfaAdmin).post("/api/v1/backup/run")).statusCode).toBe(403);
  });

  it("padrões: desligado, SFTP, 03:30, 14 cópias; serviço parado; sem histórico", async () => {
    const r = (await api(admin).get("/api/v1/backup")).json();
    expect(r.settings).toMatchObject({
      enabled: false,
      protocol: "sftp",
      scheduleTime: "03:30",
      retentionRemote: 14,
      hasPassphrase: false,
    });
    expect(r.service.alive).toBe(false);
    expect(r.runs).toEqual([]);
    expect(r.nextRunAt).toBeNull();
  });

  it("validações em português", async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ ...base, enabled: true, password: "x" }, /senha do backup/],
      [{ ...base, passphrase: "curta" }, /pelo menos 12/],
      [{ ...base, path: "../etc" }, /Pasta inválida/],
      [{ ...base, host: "a b;rm" }, /Servidor inválido/],
      [{ ...base, username: "a b" }, /Usuário inválido/],
      [{ ...base, auth: "key", privateKey: "não é chave" }, /Chave SSH inválida/],
      [
        {
          ...base,
          auth: "key",
          privateKey:
            "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nabc\n-----END RSA PRIVATE KEY-----",
        },
        /protegida por senha/,
      ],
      [{ ...base, enabled: true, passphrase: "senha-longa-do-backup" }, /senha do destino/],
    ];
    for (const [b, msg] of cases) {
      const r = await api(admin).put(S, b);
      expect(r.statusCode, JSON.stringify(b).slice(0, 80)).toBe(400);
      expect(r.json().message).toMatch(msg);
    }
  });

  it("salva com segredos cifrados; a API nunca devolve senha, chave ou senha do backup", async () => {
    const r = await api(admin).put(S, {
      ...base,
      enabled: true,
      password: "SenhaDestino123",
      passphrase: "Senha-do-backup-2026",
    });
    expect(r.statusCode).toBe(200);
    const raw = (
      await ownerQuery<{ v: string }>(
        db,
        "SELECT value::text AS v FROM system_settings WHERE key = 'integrations.backup'",
      )
    )[0]!.v;
    expect(raw).not.toContain("SenhaDestino123");
    expect(raw).not.toContain("Senha-do-backup-2026");
    const g = await api(admin).get("/api/v1/backup");
    expect(g.body).not.toMatch(/SenhaDestino123|Senha-do-backup-2026|password_enc|passphrase_enc/);
    expect(g.json().settings).toMatchObject({
      enabled: true,
      port: 22,
      hasPassword: true,
      hasPassphrase: true,
    });
    expect(Date.parse(g.json().nextRunAt)).toBeGreaterThan(Date.now());

    // Em branco mantém as senhas salvas.
    expect((await api(admin).put(S, { ...base, enabled: true })).statusCode).toBe(200);
    expect((await api(admin).get("/api/v1/backup")).json().settings.hasPassword).toBe(true);

    const audit = await ownerQuery<{ data: string }>(
      db,
      "SELECT data::text AS data FROM audit_logs WHERE action = 'backup.settings_updated'",
    );
    expect(audit.length).toBeGreaterThanOrEqual(2);
    for (const a of audit) expect(a.data).not.toMatch(/SenhaDestino123|Senha-do-backup-2026/);
  });

  it("pedidos: um por vez (409) e registro na auditoria", async () => {
    const t = await api(admin).post("/api/v1/backup/test");
    expect(t.statusCode).toBe(202);
    const again = await api(admin).post("/api/v1/backup/run");
    expect(again.statusCode).toBe(409);
    expect(again.json().message).toMatch(/em andamento/);
    const runs = (await api(admin).get("/api/v1/backup")).json().runs;
    expect(runs[0]).toMatchObject({
      kind: "test",
      trigger: "manual",
      status: "pending",
      requestedBy: "Administrador",
    });
    await ownerQuery(db, "UPDATE backup_runs SET status = 'success', finished_at = now()");
    expect((await api(admin).post("/api/v1/backup/run")).statusCode).toBe(202);
    const acts = await ownerQuery<{ action: string }>(
      db,
      "SELECT action FROM audit_logs WHERE action IN ('backup.test_requested', 'backup.run_requested') ORDER BY id",
    );
    expect(acts.map((a) => a.action)).toEqual(["backup.test_requested", "backup.run_requested"]);
  });

  it("trocar servidor esquece a identidade SFTP; aceitar nova identidade também", async () => {
    await ownerQuery(
      db,
      `UPDATE system_settings SET value = value || '{"host_keys": "backup.teste ssh-ed25519 AAAA", "host_key_fingerprint": "ED25519 SHA256:x"}'::jsonb
        WHERE key = 'integrations.backup'`,
    );
    expect((await api(admin).get("/api/v1/backup")).json().settings.hostKeyFingerprint).toBe(
      "ED25519 SHA256:x",
    );
    // Mesmo servidor: mantém.
    let r = await api(admin).put(S, { ...base, enabled: true, retentionRemote: 7 });
    expect(r.json().hostKeyReset).toBe(false);
    expect(
      (await api(admin).get("/api/v1/backup")).json().settings.hostKeyFingerprint,
    ).toBeTruthy();
    // Outro servidor: esquece.
    r = await api(admin).put(S, { ...base, enabled: true, host: "outro.teste" });
    expect(r.json().hostKeyReset).toBe(true);
    expect((await api(admin).get("/api/v1/backup")).json().settings.hostKeyFingerprint).toBeNull();
    // Aceitar nova identidade.
    await ownerQuery(
      db,
      `UPDATE system_settings SET value = value || '{"host_keys": "x", "host_key_fingerprint": "y"}'::jsonb
        WHERE key = 'integrations.backup'`,
    );
    expect((await api(admin).post("/api/v1/backup/accept-host-key")).statusCode).toBe(200);
    expect((await api(admin).get("/api/v1/backup")).json().settings.hostKeyFingerprint).toBeNull();
  });

  it("FTP/FTPS usam sempre senha (a chave SSH é descartada) e porta padrão 21", async () => {
    const r = await api(admin).put(S, {
      ...base,
      protocol: "ftps",
      auth: "key",
      password: "abcdef",
    });
    expect(r.statusCode).toBe(200);
    const s = (await api(admin).get("/api/v1/backup")).json().settings;
    expect(s).toMatchObject({ protocol: "ftps", auth: "password", port: 21, hasPrivateKey: false });
  });
});

describe("backup somente no servidor e download pelo painel", () => {
  const FILE = "topcam-20260930-150000.tar.gpg";
  const CONTENT = randomBytes(4096);
  let runId = "";

  it("somente no servidor: sem destino, exige ao menos 1 cópia; teste recusado; backup permitido", async () => {
    await ownerQuery(
      db,
      "UPDATE backup_runs SET status = 'success', finished_at = now() WHERE status IN ('pending','running')",
    );
    const local = {
      ...base,
      host: "",
      username: "",
      localOnly: true,
      enabled: true,
      passphrase: "Senha-do-backup-2026",
    };
    const zero = await api(admin).put(S, { ...local, retentionLocal: 0 });
    expect(zero.statusCode).toBe(400);
    expect(zero.json().message).toMatch(/ao menos 1 cópia/);
    expect((await api(admin).put(S, local)).statusCode).toBe(200);
    expect((await api(admin).get("/api/v1/backup")).json().settings.localOnly).toBe(true);
    const t = await api(admin).post("/api/v1/backup/test");
    expect(t.statusCode).toBe(400);
    expect(t.json().message).toMatch(/somente no servidor/);
    expect((await api(admin).post("/api/v1/backup/run")).statusCode).toBe(202);
  });

  it("só aparece como baixável o backup que ainda está no servidor", async () => {
    runId = (
      await ownerQuery<{ id: string }>(
        db,
        `UPDATE backup_runs SET status = 'success', finished_at = now(), file_name = $1
          WHERE id = (SELECT max(id) FROM backup_runs) RETURNING id::text`,
        [FILE],
      )
    )[0]!.id;
    let runs = (await api(admin).get("/api/v1/backup")).json().runs;
    expect(runs.find((r: { id: string }) => r.id === runId).downloadable).toBe(false);
    writeFileSync(join(BACKUP_DIR, FILE), CONTENT);
    runs = (await api(admin).get("/api/v1/backup")).json().runs;
    expect(runs.find((r: { id: string }) => r.id === runId).downloadable).toBe(true);
  });

  it("senha errada recusa; cliente não baixa", async () => {
    const r = await api(admin).post("/api/v1/backup/download", { runId, password: "errada-123" });
    expect(r.statusCode).toBe(400);
    expect(r.json().message).toBe("Senha incorreta");
    expect(
      (await api(alfaAdmin).post("/api/v1/backup/download", { runId, password: "GestorAlfa1" }))
        .statusCode,
    ).toBe(403);
  });

  it("senha certa → link de uso único que entrega o arquivo idêntico e registra na auditoria", async () => {
    const r = await api(admin).post("/api/v1/backup/download", {
      runId,
      password: "NovaSenha2026",
    });
    expect(r.statusCode).toBe(200);
    const { url, fileName } = r.json();
    expect(fileName).toBe(FILE);
    const dl = await app.inject({ method: "GET", url });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["content-disposition"]).toBe(`attachment; filename="${FILE}"`);
    expect(dl.headers["cache-control"]).toBe("no-store");
    expect(Buffer.compare(dl.rawPayload, CONTENT)).toBe(0);
    // Uso único.
    const again = await app.inject({ method: "GET", url });
    expect(again.statusCode).toBe(404);
    expect(again.json().message).toMatch(/expirado/);
    const a = await ownerQuery<{ data: { file: string } }>(
      db,
      "SELECT data FROM audit_logs WHERE action = 'backup.downloaded'",
    );
    expect(a).toHaveLength(1);
    expect(a[0]!.data.file).toBe(FILE);
  });

  it("link inventado ou backup que saiu do servidor: 404", async () => {
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/backup/download/abc" })).statusCode,
    ).toBe(404);
    rmSync(join(BACKUP_DIR, FILE));
    const r = await api(admin).post("/api/v1/backup/download", {
      runId,
      password: "NovaSenha2026",
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().message).toMatch(/não está mais no servidor/);
  });
});
