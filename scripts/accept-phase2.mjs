/* global process, console, fetch, setTimeout */
// TopCam — verificações da Fase 2 pela API pública (através do gateway Caddy).
// Executado DENTRO do contêiner "api" por scripts/accept-phase2.sh (Node 22, sem dependências).
//
//   node - setup  → critérios de autenticação, cadastros, isolamento, permissões e auditoria
//   node - live   → a câmera criada pelo painel entra "ao vivo" com a chave devolvida
//   node - clean  → remove as câmeras de aceite e cancela os clientes de aceite
//
// Saída: linhas "RESULT|<id>|PASS|FAIL|<critério>|<evidência>" e "OUT|<nome>|<valor>".
// Variáveis: BASE (http://gateway), ACC_EMAIL, ACC_TEMP (setup), ACC_PASSWORD, RUN (sufixo único),
//            CAM_ID (live/clean).

const BASE = process.env.BASE ?? "http://gateway";
const RUN = process.env.RUN ?? String(Date.now()).slice(-6);
const ACC_EMAIL = process.env.ACC_EMAIL;
const ACC_PASSWORD = process.env.ACC_PASSWORD;
const stage = process.argv[2];

const out = (k, v) => console.log(`OUT|${k}|${v}`);
function result(id, ok, crit, ev) {
  console.log(`RESULT|${id}|${ok ? "PASS" : "FAIL"}|${crit}|${String(ev).replace(/\|/g, "/")}`);
}

async function http(method, path, { token, body, cookie } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    redirect: "manual",
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* HTML */
  }
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const rt = setCookie.map((c) => c.split(";")[0]).find((c) => c.startsWith("topcam_rt="));
  return { status: res.status, json, text, headers: res.headers, setCookie, cookie: rt ?? "" };
}

const client = (token) => ({
  get: (p) => http("GET", p, { token }),
  post: (p, b = {}) => http("POST", p, { token, body: b }),
  patch: (p, b) => http("PATCH", p, { token, body: b }),
  put: (p, b) => http("PUT", p, { token, body: b }),
  del: (p) => http("DELETE", p, { token }),
});

async function login(email, password) {
  const r = await http("POST", "/api/v1/auth/login", { body: { email, password, client: "web" } });
  return { ...r, token: r.json?.accessToken };
}

async function activate(email, temp, next) {
  const l = await login(email, temp);
  if (l.status !== 200) throw new Error(`login de ${email}: ${l.status}`);
  const r = await client(l.token).post("/api/v1/auth/change-password", {
    currentPassword: temp,
    newPassword: next,
  });
  if (r.status !== 200) throw new Error(`troca de senha de ${email}: ${r.status} ${r.text}`);
  return l.token;
}

function must(r, status, what) {
  if (r.status !== status)
    throw new Error(`${what}: esperado ${status}, veio ${r.status} ${r.text.slice(0, 200)}`);
  return r.json;
}

// ---------------------------------------------------------------------------------------------
async function setup() {
  // P1 — painel e cabeçalhos de segurança pelo gateway
  {
    const page = await http("GET", "/login");
    const h = page.headers;
    const internal = await http("GET", "/internal/mediamtx/auth");
    const ok =
      page.status === 200 &&
      /<html/i.test(page.text) &&
      h.get("x-frame-options") === "DENY" &&
      h.get("x-content-type-options") === "nosniff" &&
      !h.get("server") &&
      internal.status === 404;
    result(
      "P1",
      ok,
      "Painel publicado pelo gateway, com cabeçalhos de segurança; rotas internas bloqueadas",
      `/login=${page.status}, X-Frame-Options=${h.get("x-frame-options")}, nosniff=${h.get("x-content-type-options")}, Server=${h.get("server") ?? "(oculto)"}, /internal=${internal.status}`,
    );
  }

  // P2 — login, primeiro acesso, cookie seguro
  let admin;
  {
    const wrong = await login(ACC_EMAIL, "senha-errada-123");
    const ghost = await login(`ninguem-${RUN}@aceite.invalid`, "senha-errada-123");
    const first = await login(ACC_EMAIL, process.env.ACC_TEMP);
    const blocked = await client(first.token).get("/api/v1/tenants");
    const cookieAttrs = first.setCookie.find((c) => c.startsWith("topcam_rt=")) ?? "";
    admin = await activate(ACC_EMAIL, process.env.ACC_TEMP, ACC_PASSWORD);
    const after = await client(admin).get("/api/v1/tenants");
    const ok =
      wrong.status === 401 &&
      ghost.status === 401 &&
      wrong.json?.message === ghost.json?.message &&
      first.status === 200 &&
      first.json?.user?.mustChangePassword === true &&
      blocked.status === 403 &&
      blocked.json?.error === "password_change_required" &&
      /HttpOnly/i.test(cookieAttrs) &&
      /SameSite=Strict/i.test(cookieAttrs) &&
      /Path=\/api\/v1\/auth/i.test(cookieAttrs) &&
      after.status === 200;
    result(
      "P2",
      ok,
      "Login com mensagem única para erro; troca de senha obrigatória no 1º acesso; cookie httpOnly/Strict",
      `senha errada=${wrong.status}, e-mail inexistente=${ghost.status} (mesma msg: ${wrong.json?.message === ghost.json?.message}), 1º acesso bloqueado=${blocked.status}/${blocked.json?.error}, cookie="${cookieAttrs.split(";").slice(1).join(";").trim()}", após troca=${after.status}`,
    );
  }

  // P3 — rate limit de login
  {
    const email = `alvo-${RUN}@aceite.invalid`;
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await login(email, "x-errada")).status);
    result(
      "P3",
      codes.slice(0, 5).every((c) => c === 401) && codes[5] === 429,
      "Bloqueio após 5 tentativas erradas no mesmo e-mail (15 min)",
      `respostas: ${codes.join(", ")}`,
    );
  }

  // P4 — refresh rotaciona; logout encerra
  {
    const l = await login(ACC_EMAIL, ACC_PASSWORD);
    const r1 = await http("POST", "/api/v1/auth/refresh", { cookie: l.cookie });
    const out1 = await client(l.token).post("/api/v1/auth/logout");
    const me = await client(l.token).get("/api/v1/auth/me");
    const r2 = await http("POST", "/api/v1/auth/refresh", { cookie: r1.cookie });
    result(
      "P4",
      r1.status === 200 &&
        r1.cookie &&
        r1.cookie !== l.cookie &&
        out1.status === 200 &&
        me.status === 401 &&
        r2.status === 401,
      "Refresh token rotacionado a cada uso; logout invalida acesso e refresh na hora",
      `refresh=${r1.status} (cookie novo: ${r1.cookie !== l.cookie}), logout=${out1.status}, /me depois=${me.status}, refresh depois=${r2.status}`,
    );
  }
  admin = (await login(ACC_EMAIL, ACC_PASSWORD)).token;
  const a = client(admin);

  // P5 — dois clientes fictícios com local, grupo e câmeras (chave exclusiva)
  const tenants = {};
  const keys = new Set();
  let ingestServer = "";
  for (const tag of ["A", "B"]) {
    const t = must(
      await a.post("/api/v1/tenants", { name: `Aceite F2 ${tag} ${RUN}`, planCode: "basico" }),
      201,
      `criar cliente ${tag}`,
    );
    const l = must(
      await a.post("/api/v1/locations", { tenantId: t.id, name: "Matriz" }),
      201,
      "criar local",
    );
    const g = must(
      await a.post("/api/v1/camera-groups", { locationId: l.id, name: "Frente" }),
      201,
      "criar grupo",
    );
    const cams = [];
    for (const name of ["Portaria", "Estoque"]) {
      const c = must(
        await a.post("/api/v1/cameras", { tenantId: t.id, locationId: l.id, groupId: g.id, name }),
        201,
        "criar câmera",
      );
      keys.add(c.ingest.streamKey);
      ingestServer = c.ingest.server;
      cams.push({ id: c.camera.id, code: c.camera.code, key: c.ingest.streamKey });
    }
    tenants[tag] = { id: t.id, slug: t.slug, cams };
    out(`TENANT_${tag}`, t.id);
  }
  result(
    "P5",
    keys.size === 4 && tenants.A.cams[0].code === "CAM-001" && tenants.A.cams[1].code === "CAM-002",
    "Cadastro de clientes, local, grupo e câmeras pelo painel/API; chave exclusiva por câmera",
    `clientes ${tenants.A.slug} e ${tenants.B.slug}; 4 câmeras, ${keys.size} chaves distintas; servidor ${ingestServer}`,
  );
  out("CAM_ID", tenants.A.cams[0].id);
  out("CAM_KEY", tenants.A.cams[0].key);
  out("CAM_IDS", [...tenants.A.cams, ...tenants.B.cams].map((c) => c.id).join(","));

  // P6 — administrador do cliente A isolado do cliente B
  const ta = must(
    await a.post("/api/v1/users", {
      name: "Gestor Aceite",
      email: `gestor-${RUN}@aceite.invalid`,
      role: "tenant_admin",
      tenantId: tenants.A.id,
    }),
    201,
    "criar tenant_admin",
  );
  const taToken = await activate(
    `gestor-${RUN}@aceite.invalid`,
    ta.temporaryPassword,
    `GestorAceite${RUN}x`,
  );
  const t = client(taToken);
  {
    const cams = (await t.get("/api/v1/cameras")).json?.items ?? [];
    const otherCam = await t.get(`/api/v1/cameras/${tenants.B.cams[0].id}`);
    const otherTenant = await t.get(`/api/v1/tenants/${tenants.B.id}`);
    const tenantList = (await t.get("/api/v1/tenants")).json?.items ?? [];
    const key = await t.get(`/api/v1/cameras/${tenants.A.cams[0].id}/stream-key`);
    const escalate = await t.post("/api/v1/users", {
      name: "Invasor",
      email: `x-${RUN}@aceite.invalid`,
      role: "platform_admin",
    });
    const ok =
      cams.length === 2 &&
      cams.every((c) => tenants.A.cams.some((x) => x.id === c.id)) &&
      cams.every((c) => c.streamKeyPrefix === undefined) &&
      otherCam.status === 404 &&
      otherTenant.status === 403 &&
      tenantList.length === 1 &&
      key.status === 403 &&
      escalate.status === 403;
    result(
      "P6",
      ok,
      "Administrador do cliente A não enxerga nada do cliente B nem as chaves; não cria papel da plataforma",
      `câmeras visíveis=${cams.length} (todas do A), câmera do B=${otherCam.status}, cliente B=${otherTenant.status}, clientes listados=${tenantList.length}, ver chave=${key.status}, criar Super Admin=${escalate.status}`,
    );
  }

  // P7 — visualizador só vê a câmera concedida
  {
    const v = must(
      await t.post("/api/v1/users", {
        name: "Porteiro Aceite",
        email: `porteiro-${RUN}@aceite.invalid`,
        role: "viewer",
      }),
      201,
      "criar viewer",
    );
    const vToken = await activate(
      `porteiro-${RUN}@aceite.invalid`,
      v.temporaryPassword,
      `PorteiroAceite${RUN}x`,
    );
    const vc = client(vToken);
    const before = (await vc.get("/api/v1/cameras")).json?.items?.length;
    const grant = await t.put(`/api/v1/users/${v.user.id}/camera-permissions`, {
      items: [{ cameraId: tenants.A.cams[0].id, canLive: true }],
    });
    const afterItems = (await vc.get("/api/v1/cameras")).json?.items ?? [];
    const notGranted = await vc.get(`/api/v1/cameras/${tenants.A.cams[1].id}`);
    const otherTenant = await vc.get(`/api/v1/cameras/${tenants.B.cams[0].id}`);
    const edit = await vc.patch(`/api/v1/cameras/${tenants.A.cams[0].id}`, { name: "x" });
    const users = await vc.get("/api/v1/users");
    const crossGrant = await t.put(`/api/v1/users/${v.user.id}/camera-permissions`, {
      items: [{ cameraId: tenants.B.cams[0].id, canLive: true }],
    });
    const ok =
      before === 0 &&
      grant.status === 200 &&
      afterItems.length === 1 &&
      afterItems[0].id === tenants.A.cams[0].id &&
      notGranted.status === 404 &&
      otherTenant.status === 404 &&
      edit.status === 403 &&
      users.status === 403 &&
      crossGrant.status === 400;
    result(
      "P7",
      ok,
      "Visualizador vê só as câmeras concedidas; permissão com câmera de outro cliente é recusada",
      `antes da permissão=${before}, depois=${afterItems.length}, câmera não concedida=${notGranted.status}, câmera do B=${otherTenant.status}, editar=${edit.status}, usuários=${users.status}, conceder câmera do B=${crossGrant.status}`,
    );
  }

  // P8 — chave: exibir e trocar ficam auditados
  {
    const cam = tenants.A.cams[1];
    const k1 = (await a.get(`/api/v1/cameras/${cam.id}/stream-key`)).json?.streamKey;
    const rot = await a.post(`/api/v1/cameras/${cam.id}/rotate-key`);
    const k2 = (await a.get(`/api/v1/cameras/${cam.id}/stream-key`)).json?.streamKey;
    result(
      "P8",
      k1 === cam.key && rot.status === 200 && k2 === rot.json?.streamKey && k2 !== k1,
      "Exibir e trocar a chave de transmissão pelo painel (chave nova substitui a antiga)",
      `exibir=${k1 === cam.key ? "ok" : "divergente"}, trocar=${rot.status}, chave nova ≠ antiga: ${k2 !== k1}`,
    );
  }

  // P9 — desativar câmera e suspender cliente
  {
    const cam = tenants.B.cams[1];
    const dis = await a.patch(`/api/v1/cameras/${cam.id}`, { enabled: false });
    const st1 = (await a.get(`/api/v1/cameras/${cam.id}`)).json?.status;
    const susp = await a.post(`/api/v1/tenants/${tenants.B.id}/status`, { status: "suspended" });
    const st2 = (await a.get(`/api/v1/tenants/${tenants.B.id}`)).json?.status;
    result(
      "P9",
      dis.status === 200 && st1 === "desabilitada" && susp.status === 200 && st2 === "suspended",
      "Desabilitar câmera e suspender cliente",
      `desabilitar=${dis.status} → ${st1}; suspender=${susp.status} → ${st2}`,
    );
  }

  // P10 — tudo na auditoria
  {
    const actions = new Set();
    let r;
    for (let page = 1; page <= 3; page++) {
      r = await a.get(`/api/v1/audit-logs?pageSize=100&page=${page}`);
      for (const x of r.json?.items ?? []) actions.add(x.action);
    }
    const need = [
      "auth.login",
      "auth.login_failed",
      "auth.login_rate_limited",
      "auth.logout",
      "auth.password_changed",
      "tenant.created",
      "tenant.suspended",
      "location.created",
      "camera_group.created",
      "camera.created",
      "camera.disabled",
      "user.created",
      "user.camera_permissions_updated",
      "camera.stream_key_viewed",
      "camera.stream_key_rotated",
    ];
    const missing = need.filter((x) => !actions.has(x));
    result(
      "P10",
      r.status === 200 && missing.length === 0,
      "Toda alteração e acesso a chave aparece na auditoria",
      missing.length
        ? `faltando: ${missing.join(", ")}`
        : `${need.length} tipos de ação conferidos`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
async function live() {
  const a = client((await login(ACC_EMAIL, ACC_PASSWORD)).token);
  const id = process.env.CAM_ID;
  const seen = [];
  const start = Date.now();
  let cam;
  while (Date.now() - start < 60_000) {
    cam = (await a.get(`/api/v1/cameras/${id}`)).json;
    if (cam && seen.at(-1) !== cam.status) seen.push(cam.status);
    if (cam?.status === "ao_vivo") break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const secs = Math.round((Date.now() - start) / 1000);
  result(
    "P11",
    cam?.status === "ao_vivo" && cam?.videoCodec,
    "Câmera cadastrada pelo painel recebe a transmissão com a chave exibida e fica Ao vivo",
    `estados: ${seen.join(" → ")} em ${secs}s; ${cam?.videoCodec ?? "?"} ${cam?.width ?? "?"}x${cam?.height ?? "?"} @ ${cam?.fps ?? "?"} fps`,
  );
}

async function clean() {
  const a = client((await login(ACC_EMAIL, ACC_PASSWORD)).token);
  for (const id of (process.env.CAM_IDS ?? "").split(",").filter(Boolean))
    await a.del(`/api/v1/cameras/${id}`);
  for (const id of [process.env.TENANT_A, process.env.TENANT_B].filter(Boolean)) {
    // Usuários dos clientes de aceite saem das listas (exclusão lógica; a auditoria fica).
    const users = (await a.get(`/api/v1/users?tenantId=${id}&pageSize=100`)).json?.items ?? [];
    for (const u of users) await a.del(`/api/v1/users/${u.id}`);
    await a.post(`/api/v1/tenants/${id}/status`, { status: "cancelled" });
  }
}

try {
  if (stage === "setup") await setup();
  else if (stage === "live") await live();
  else if (stage === "clean") await clean();
  else throw new Error("etapa desconhecida");
} catch (err) {
  console.log(`ERROR|${err.message}`);
  process.exitCode = 1;
}
