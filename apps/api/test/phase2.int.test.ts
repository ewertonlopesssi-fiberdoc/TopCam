import { randomBytes } from "node:crypto";
import { createPool, type Pool } from "@topcam/db";
import { type MediaMtxClient } from "@topcam/shared";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
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

let db: TestDb;
let pool: Pool;
let redis: Redis;
let app: FastifyInstance;

const ADMIN = { email: "admin@test.local", password: "senha-de-teste-123" };
const NEW_ADMIN_PW = "NovaSenhaForte2026";

beforeAll(async () => {
  db = await createTestDb();
  pool = createPool(db.appUrl, 4);
  redis = new Redis(REDIS_URL);
  await redis.flushdb();
  const env = loadEnv({
    DATABASE_URL: db.appUrl,
    REDIS_URL,
    MEDIA_HOOK_SECRET: randomBytes(24).toString("hex"),
    MEDIA_READ_PASSWORD: randomBytes(16).toString("hex"),
    STREAM_KEY_ENC_KEY: db.encKeyB64,
    JWT_SECRET: randomBytes(32).toString("hex"),
    LOG_LEVEL: "silent",
    PUBLIC_HOST: "video.teste.local",
  });
  app = await buildApp({
    env,
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
});

// ------------------------------------------------------------------ utilitários
function cookieOf(res: LightMyRequestResponse): string {
  const c = res.cookies.find((x) => x.name === "topcam_rt");
  return c ? `topcam_rt=${c.value}` : "";
}

async function login(email: string, password: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password },
  });
  return { res, token: res.json().accessToken as string, cookie: cookieOf(res) };
}

function api(token: string) {
  const call = (
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
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
    patch: (u: string, p: unknown) => call("PATCH", u, p),
    put: (u: string, p: unknown) => call("PUT", u, p),
    del: (u: string) => call("DELETE", u),
  };
}

/** Faz o primeiro acesso (troca obrigatória de senha) e devolve o token. */
async function activate(email: string, temp: string, next: string): Promise<string> {
  const { token } = await login(email, temp);
  const r = await api(token).post("/api/v1/auth/change-password", {
    currentPassword: temp,
    newPassword: next,
  });
  expect(r.statusCode).toBe(200);
  return token;
}

async function auditActions(): Promise<string[]> {
  return (
    await ownerQuery<{ action: string }>(db, "SELECT action FROM audit_logs ORDER BY id")
  ).map((r) => r.action);
}

let adminToken = "";

// ------------------------------------------------------------------ autenticação
describe("autenticação", () => {
  it("recusa senha errada e e-mail inexistente com a mesma mensagem", async () => {
    const a = await login(ADMIN.email, "errada-123456");
    const b = await login("ninguem@test.local", "errada-123456");
    expect(a.res.statusCode).toBe(401);
    expect(b.res.statusCode).toBe(401);
    expect(a.res.json().message).toBe(b.res.json().message);
  });

  it("bloqueia após 5 tentativas erradas no mesmo e-mail", async () => {
    for (let i = 0; i < 5; i++)
      expect((await login("alvo@test.local", "x")).res.statusCode).toBe(401);
    expect((await login("alvo@test.local", "x")).res.statusCode).toBe(429);
    expect((await login("alvo@test.local", "x")).res.statusCode).toBe(429);
    // O bloqueio vai para a auditoria uma única vez por janela.
    expect((await auditActions()).filter((a) => a === "auth.login_rate_limited")).toHaveLength(1);
  });

  it("primeiro acesso exige troca de senha antes de usar a API", async () => {
    const { res, token, cookie } = await login(ADMIN.email, ADMIN.password);
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ role: "platform_admin", mustChangePassword: true });
    const rt = res.cookies.find((c) => c.name === "topcam_rt")!;
    expect(rt.httpOnly).toBe(true);
    expect(rt.sameSite).toBe("Strict");
    expect(rt.path).toBe("/api/v1/auth");
    expect(cookie).not.toBe("");

    const blocked = await api(token).get("/api/v1/tenants");
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toBe("password_change_required");
    expect((await api(token).get("/api/v1/auth/me")).statusCode).toBe(200);

    const weak = await api(token).post("/api/v1/auth/change-password", {
      currentPassword: ADMIN.password,
      newPassword: "curta1",
    });
    expect(weak.statusCode).toBe(400);
    const ok = await api(token).post("/api/v1/auth/change-password", {
      currentPassword: ADMIN.password,
      newPassword: NEW_ADMIN_PW,
    });
    expect(ok.statusCode).toBe(200);
    expect((await api(token).get("/api/v1/tenants")).statusCode).toBe(200);
    adminToken = token;
  });

  it("sem token ou com token inválido → 401", async () => {
    expect((await app.inject({ url: "/api/v1/tenants" })).statusCode).toBe(401);
    expect((await api("abc.def.ghi").get("/api/v1/tenants")).statusCode).toBe(401);
  });

  it("refresh rotaciona o token; reuso dentro da tolerância é aceito, fora dela encerra a sessão", async () => {
    const { cookie } = await login(ADMIN.email, NEW_ADMIN_PW);
    const r1 = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { cookie },
    });
    expect(r1.statusCode).toBe(200);
    expect(cookieOf(r1)).not.toBe(cookie);
    // Recarga da página no meio da renovação: o token anterior ainda vale por alguns segundos.
    const grace = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { cookie },
    });
    expect(grace.statusCode).toBe(200);
    const latest = cookieOf(grace);
    // Passada a tolerância, reusar o token antigo encerra a sessão (possível roubo)...
    await ownerQuery(db, "UPDATE sessions SET rotated_at = now() - interval '5 minutes'");
    const reuse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { cookie },
    });
    expect(reuse.statusCode).toBe(401);
    // ...inclusive para o token mais recente.
    const after = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { cookie: latest },
    });
    expect(after.statusCode).toBe(401);
    expect(await auditActions()).toContain("auth.refresh_reuse_detected");
  });

  it("logout encerra a sessão na hora", async () => {
    const { token } = await login(ADMIN.email, NEW_ADMIN_PW);
    expect((await api(token).post("/api/v1/auth/logout")).statusCode).toBe(200);
    expect((await api(token).get("/api/v1/auth/me")).statusCode).toBe(401);
  });
});

// ------------------------------------------------------------------ cadastros e permissões
describe("cadastros, papéis e isolamento", () => {
  let tenantId = "";
  let otherTenantId = "";
  let locationId = "";
  let groupId = "";
  const cameraIds: string[] = [];
  let tenantAdminToken = "";
  let viewerToken = "";
  let viewerId = "";

  it("administrador cria cliente, local, grupo e câmeras (com chave exclusiva)", async () => {
    const a = api(adminToken);
    const t = await a.post("/api/v1/tenants", {
      name: "Loja Centro",
      planCode: "basico",
      contactEmail: "contato@lojacentro.test",
    });
    expect(t.statusCode).toBe(201);
    tenantId = t.json().id;
    expect(t.json()).toMatchObject({
      slug: "loja-centro",
      planCode: "basico",
      cameraCount: 0,
      status: "active",
    });
    otherTenantId = (
      await ownerQuery<{ id: string }>(db, "SELECT id FROM tenants WHERE slug = 'empresa-alfa'")
    )[0]!.id;

    const l = await a.post("/api/v1/locations", { tenantId, name: "Matriz" });
    expect(l.statusCode).toBe(201);
    locationId = l.json().id;
    expect((await a.post("/api/v1/locations", { tenantId, name: "Matriz" })).statusCode).toBe(409);
    const g = await a.post("/api/v1/camera-groups", { locationId, name: "Frente" });
    expect(g.statusCode).toBe(201);
    groupId = g.json().id;

    const keys = new Set<string>();
    for (const name of ["Caixa 01", "Estoque"]) {
      const c = await a.post("/api/v1/cameras", { tenantId, locationId, groupId, name });
      expect(c.statusCode).toBe(201);
      cameraIds.push(c.json().camera.id);
      expect(c.json().ingest.server).toBe("rtmp://video.teste.local:1935/live");
      keys.add(c.json().ingest.streamKey);
    }
    expect(keys.size).toBe(2);
    const list = await a.get(`/api/v1/cameras?tenantId=${tenantId}`);
    expect(list.json().items.map((c: { code: string }) => c.code)).toEqual(["CAM-001", "CAM-002"]);
    const jobs = await ownerQuery(
      db,
      "SELECT 1 FROM durable_jobs WHERE type = 'mediamtx.reconcile'",
    );
    expect(jobs.length).toBeGreaterThan(0);
  });

  it("valida local/grupo de outro cliente e limite do plano", async () => {
    const a = api(adminToken);
    const alfaLoc = (
      await ownerQuery<{ id: string }>(db, "SELECT id FROM locations WHERE tenant_id = $1", [
        otherTenantId,
      ])
    )[0]!.id;
    const bad = await a.post("/api/v1/cameras", { tenantId, locationId: alfaLoc, name: "X" });
    expect(bad.statusCode).toBe(400);
    await ownerQuery(db, "UPDATE plans SET max_cameras = 2 WHERE code = 'basico'");
    const over = await a.post("/api/v1/cameras", { tenantId, locationId, name: "Terceira" });
    expect(over.statusCode).toBe(409);
    expect(over.json().error).toBe("plan_limit");
    await ownerQuery(db, "UPDATE plans SET max_cameras = 50 WHERE code = 'basico'");
  });

  it("administrador cria usuários do cliente com senha temporária", async () => {
    const a = api(adminToken);
    const ta = await a.post("/api/v1/users", {
      name: "Gerente",
      email: "gerente@lojacentro.test",
      role: "tenant_admin",
      tenantId,
    });
    expect(ta.statusCode).toBe(201);
    expect(ta.json().temporaryPassword).toMatch(/^[A-Za-z0-9]{14}$/);
    tenantAdminToken = await activate(
      "gerente@lojacentro.test",
      ta.json().temporaryPassword,
      "AdminLoja2026ok",
    );
    expect(
      (
        await a.post("/api/v1/users", {
          name: "Dup",
          email: "gerente@lojacentro.test",
          role: "viewer",
          tenantId,
        })
      ).statusCode,
    ).toBe(409);
    // Papel da plataforma não pode ter cliente; papel de cliente exige cliente.
    expect(
      (
        await a.post("/api/v1/users", {
          name: "X",
          email: "x1@t.test",
          role: "platform_admin",
          tenantId,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await a.post("/api/v1/users", { name: "X", email: "x2@t.test", role: "viewer" })).statusCode,
    ).toBe(400);
  });

  it("administrador do cliente só gerencia o próprio cliente", async () => {
    const t = api(tenantAdminToken);
    const v = await t.post("/api/v1/users", {
      name: "Porteiro",
      email: "porteiro@lojacentro.test",
      role: "viewer",
    });
    expect(v.statusCode).toBe(201);
    expect(v.json().user.tenantId).toBe(tenantId);
    viewerId = v.json().user.id;
    viewerToken = await activate(
      "porteiro@lojacentro.test",
      v.json().temporaryPassword,
      "AcessoPortao2026",
    );

    expect(
      (await t.post("/api/v1/users", { name: "Hack", email: "h@t.test", role: "platform_admin" }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await t.post("/api/v1/users", {
          name: "Hack",
          email: "h2@t.test",
          role: "viewer",
          tenantId: otherTenantId,
        })
      ).json().user.tenantId,
    ).toBe(tenantId);
    const users = await t.get("/api/v1/users");
    expect(users.json().items.every((u: { tenantId: string }) => u.tenantId === tenantId)).toBe(
      true,
    );
    expect((await t.get(`/api/v1/tenants/${otherTenantId}`)).statusCode).toBe(403);
    expect((await t.get("/api/v1/tenants")).json().items.map((x: { id: string }) => x.id)).toEqual([
      tenantId,
    ]);
    // Vê todas as câmeras do próprio cliente, sem a chave.
    const cams = (await t.get("/api/v1/cameras")).json().items;
    expect(cams).toHaveLength(2);
    expect(cams[0].streamKeyPrefix).toBeUndefined();
    expect((await t.get(`/api/v1/cameras/${cameraIds[0]}/stream-key`)).statusCode).toBe(403);
    expect(
      (await t.post("/api/v1/cameras", { tenantId, locationId, name: "Nova" })).statusCode,
    ).toBe(403);
    expect(
      (await t.post("/api/v1/tenants", { name: "Outro", planCode: "basico" })).statusCode,
    ).toBe(403);
  });

  it("visualizador só vê câmeras concedidas", async () => {
    const v = api(viewerToken);
    expect((await v.get("/api/v1/cameras")).json().items).toHaveLength(0);
    const grant = await api(tenantAdminToken).put(`/api/v1/users/${viewerId}/camera-permissions`, {
      items: [{ cameraId: cameraIds[0], canLive: true }],
    });
    expect(grant.statusCode).toBe(200);
    const cams = (await v.get("/api/v1/cameras")).json().items;
    expect(cams.map((c: { id: string }) => c.id)).toEqual([cameraIds[0]]);
    expect((await v.get(`/api/v1/cameras/${cameraIds[1]}`)).statusCode).toBe(404);
    const alfaCam = (
      await ownerQuery<{ id: string }>(db, "SELECT id FROM cameras WHERE tenant_id = $1 LIMIT 1", [
        otherTenantId,
      ])
    )[0]!.id;
    expect((await v.get(`/api/v1/cameras/${alfaCam}`)).statusCode).toBe(404);
    expect((await v.patch(`/api/v1/cameras/${cameraIds[0]}`, { name: "x" })).statusCode).toBe(403);
    expect((await v.get("/api/v1/users")).statusCode).toBe(403);
    // Permissão com câmera de outro cliente é recusada.
    const bad = await api(tenantAdminToken).put(`/api/v1/users/${viewerId}/camera-permissions`, {
      items: [{ cameraId: alfaCam, canLive: true }],
    });
    expect(bad.statusCode).toBe(400);
  });

  it("exibir e trocar a chave ficam auditados; a chave antiga deixa de valer", async () => {
    const a = api(adminToken);
    const k1 = (await a.get(`/api/v1/cameras/${cameraIds[1]}/stream-key`)).json().streamKey;
    const r = await a.post(`/api/v1/cameras/${cameraIds[1]}/rotate-key`);
    expect(r.statusCode).toBe(200);
    expect(r.json().streamKey).not.toBe(k1);
    const k2 = (await a.get(`/api/v1/cameras/${cameraIds[1]}/stream-key`)).json().streamKey;
    expect(k2).toBe(r.json().streamKey);
    const actions = await auditActions();
    expect(actions.filter((x) => x === "camera.stream_key_viewed").length).toBeGreaterThanOrEqual(
      2,
    );
    expect(actions).toContain("camera.stream_key_rotated");
  });

  it("desativar câmera e excluir mantêm histórico", async () => {
    const a = api(adminToken);
    const d = await a.patch(`/api/v1/cameras/${cameraIds[1]}`, { enabled: false });
    expect(d.json()).toMatchObject({ enabled: false, status: "desabilitada" });
    expect(
      (await a.patch(`/api/v1/cameras/${cameraIds[1]}`, { enabled: true })).json().status,
    ).toBe("aguardando_transmissao");
    expect((await a.del(`/api/v1/cameras/${cameraIds[1]}`)).statusCode).toBe(200);
    expect((await a.get(`/api/v1/cameras/${cameraIds[1]}`)).statusCode).toBe(404);
    const row = (
      await ownerQuery(db, "SELECT deleted_at, enabled FROM cameras WHERE id = $1", [cameraIds[1]])
    )[0]!;
    expect(row.deleted_at).not.toBeNull();
    expect((await a.del(`/api/v1/camera-groups/${groupId}`)).statusCode).toBe(409);
  });

  it("toda alteração aparece na auditoria; cliente vê só a própria", async () => {
    const actions = await auditActions();
    for (const a of [
      "auth.login",
      "auth.password_changed",
      "tenant.created",
      "location.created",
      "camera_group.created",
      "camera.created",
      "user.created",
      "user.camera_permissions_updated",
      "camera.disabled",
      "camera.enabled",
      "camera.deleted",
    ]) {
      expect(actions, a).toContain(a);
    }
    const mine = await api(tenantAdminToken).get("/api/v1/audit-logs?pageSize=100");
    expect(mine.statusCode).toBe(200);
    expect(mine.json().items.every((x: { tenantId: string }) => x.tenantId === tenantId)).toBe(
      true,
    );
    expect((await api(viewerToken).get("/api/v1/audit-logs")).statusCode).toBe(403);
  });

  it("desativar usuário e suspender cliente cortam o acesso na hora", async () => {
    const a = api(adminToken);
    expect((await a.patch(`/api/v1/users/${viewerId}`, { status: "disabled" })).statusCode).toBe(
      200,
    );
    expect((await api(viewerToken).get("/api/v1/cameras")).statusCode).toBe(401);
    expect((await login("porteiro@lojacentro.test", "AcessoPortao2026")).res.statusCode).toBe(403);

    expect(
      (await a.post(`/api/v1/tenants/${tenantId}/status`, { status: "suspended" })).statusCode,
    ).toBe(200);
    expect((await api(tenantAdminToken).get("/api/v1/cameras")).statusCode).toBe(401);
    expect((await login("gerente@lojacentro.test", "AdminLoja2026ok")).res.statusCode).toBe(403);
    expect(
      (await a.post(`/api/v1/tenants/${tenantId}/status`, { status: "active" })).statusCode,
    ).toBe(200);
    expect((await login("gerente@lojacentro.test", "AdminLoja2026ok")).res.statusCode).toBe(200);
  });

  it("o administrador não altera o próprio papel nem se desativa", async () => {
    const me = (await api(adminToken).get("/api/v1/auth/me")).json();
    expect(
      (await api(adminToken).patch(`/api/v1/users/${me.id}`, { status: "disabled" })).statusCode,
    ).toBe(403);
  });

  it("metadados e configurações", async () => {
    const meta = (await api(adminToken).get("/api/v1/meta")).json();
    expect(meta.plans.map((p: { code: string }) => p.code)).toEqual([
      "basico",
      "pro",
      "enterprise",
    ]);
    expect(meta.roles.filter((r: { assignable: boolean }) => r.assignable)).toHaveLength(5);
    const tMeta = (await api(tenantAdminToken).get("/api/v1/meta")).json();
    expect(
      tMeta.roles
        .filter((r: { assignable: boolean }) => r.assignable)
        .map((r: { key: string }) => r.key),
    ).toEqual(expect.arrayContaining(["tenant_admin", "operator", "viewer"]));
    expect(
      (await api(adminToken).put("/api/v1/settings", { platformName: "TopCam Lab" })).statusCode,
    ).toBe(200);
    expect((await api(adminToken).get("/api/v1/settings")).json().platformName).toBe("TopCam Lab");
    expect(
      (await api(tenantAdminToken).put("/api/v1/settings", { platformName: "x" })).statusCode,
    ).toBe(403);
  });

  it("limites dos planos são editáveis só pelo Super Admin e não ficam abaixo do uso", async () => {
    const a = api(adminToken);
    const list = (await a.get("/api/v1/plans")).json().items;
    const basico = list.find((p: { code: string }) => p.code === "basico");
    expect(basico).toMatchObject({ maxCameras: 50, maxCamerasInUse: 1 });
    const upd = await a.patch("/api/v1/plans/basico", { maxCameras: 8, maxStorageGb: 20 });
    expect(upd.statusCode).toBe(200);
    expect(upd.json()).toMatchObject({ maxCameras: 8, maxStorageBytes: 20 * 1024 ** 3 });
    expect((await a.patch("/api/v1/plans/basico", { maxCameras: 0 })).statusCode).toBe(400);
    // Um cliente do plano Pro (Empresa Alfa) tem 5 câmeras.
    const low = await a.patch("/api/v1/plans/pro", { maxCameras: 4 });
    expect(low.statusCode).toBe(409);
    expect((await a.patch("/api/v1/plans/inexistente", { maxCameras: 9 })).statusCode).toBe(404);
    expect((await api(tenantAdminToken).get("/api/v1/plans")).statusCode).toBe(200);
    expect(
      (await api(tenantAdminToken).patch("/api/v1/plans/basico", { maxCameras: 999 })).statusCode,
    ).toBe(403);
    expect(await auditActions()).toContain("plan.updated");
    await a.patch("/api/v1/plans/basico", { maxCameras: 50, maxStorageGb: 10240 });
  });
});
