/* global process, console, fetch, Buffer */
// TopCam — verificações pela API e pelo gateway da Fase 6 (armazenamento).
// Executado DENTRO do contêiner "api" por scripts/accept-phase6.sh.
//
//   node - live    → S4b: com a gravação parada por disco cheio, o ao vivo continua (HLS)
//   node - api     → S7: API de armazenamento e servidores (admin 200; cliente 403)
//   node - clean   → exclui o usuário de cliente de teste
//
// Saída: "OUT|<nome>|<valor>" e "RESULT|<id>|PASS|FAIL|<critério>|<evidência>".

const BASE = process.env.BASE ?? "http://gateway:8080";
const RUN = process.env.RUN ?? String(Date.now()).slice(-6);
const { ACC_EMAIL, ACC_TEMP, CAM1 } = process.env;
const PASSWORD = `AceiteFase6-${RUN}-Ok`;
const stage = process.argv[2];

const out = (k, v) => console.log(`OUT|${k}|${v}`);
const result = (id, ok, crit, ev) =>
  console.log(`RESULT|${id}|${ok ? "PASS" : "FAIL"}|${crit}|${String(ev).replace(/\|/g, "/")}`);

async function http(method, path, { token, body } = {}) {
  const res = await fetch(path.startsWith("http") ? path : `${BASE}${path}`, {
    method,
    redirect: "manual",
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try {
    json = JSON.parse(buf.toString("utf8"));
  } catch {
    /* não é JSON */
  }
  return { status: res.status, json, text: buf.toString("utf8") };
}
const login = async (email, password) =>
  (await http("POST", "/api/v1/auth/login", { body: { email, password } })).json?.accessToken;

async function admin() {
  let t = await login(ACC_EMAIL, PASSWORD);
  if (t) return t;
  t = await login(ACC_EMAIL, ACC_TEMP);
  await http("POST", "/api/v1/auth/change-password", {
    token: t,
    body: { currentPassword: ACC_TEMP, newPassword: PASSWORD },
  });
  return login(ACC_EMAIL, PASSWORD);
}

async function live() {
  const t = await admin();
  const s = await http("POST", `/api/v1/cameras/${CAM1}/live`, { token: t });
  const hls = s.json?.hls;
  const idx = hls ? await http("GET", hls) : { status: 0, text: "" };
  const ready = await http("GET", "http://127.0.0.1:3000/ready").catch(() => ({ status: 0 }));
  out("LIVE", `${s.status}/${idx.status}`);
  result(
    "S4b",
    s.status === 200 && idx.status === 200 && /#EXTM3U/.test(idx.text),
    "Com a gravação parada por disco cheio, o ao vivo e o painel continuam",
    `endereço ${s.status}; HLS ${idx.status}${/#EXTM3U/.test(idx.text) ? " (playlist válida)" : ""}; API ${ready.status || "?"}`,
  );
}

async function apiChecks() {
  const t = await admin();
  const st = await http("GET", "/api/v1/storage", { token: t });
  const sv = await http("GET", "/api/v1/servers", { token: t });
  const tenantId = (await http("GET", `/api/v1/cameras/${CAM1}`, { token: t })).json?.tenantId;
  const created = await http("POST", "/api/v1/users", {
    token: t,
    body: {
      name: `Aceite6 Gestor ${RUN}`,
      email: `aceite6-gestor-${RUN}@topcam.local`,
      role: "tenant_admin",
      tenantId,
    },
  });
  out("GESTOR_ID", created.json?.user?.id ?? "");
  let ct = await login(`aceite6-gestor-${RUN}@topcam.local`, created.json?.temporaryPassword);
  await http("POST", "/api/v1/auth/change-password", {
    token: ct,
    body: {
      currentPassword: created.json?.temporaryPassword,
      newPassword: `Gestao6-${RUN}-Segura`,
    },
  });
  ct = await login(`aceite6-gestor-${RUN}@topcam.local`, `Gestao6-${RUN}-Segura`);
  const denied = await http("GET", "/api/v1/storage", { token: ct });
  const denied2 = await http("GET", "/api/v1/servers", { token: ct });
  const host = sv.json?.items?.[0]?.metrics?.host;
  const svc = host?.services ?? {};
  const allOk = Object.keys(svc).length >= 5 && Object.values(svc).every((v) => v === "ok");
  result(
    "S7",
    st.status === 200 &&
      st.json?.nodes?.length >= 1 &&
      sv.status === 200 &&
      host &&
      allOk &&
      denied.status === 403 &&
      denied2.status === 403,
    "Telas Armazenamento e Servidores: dados da plataforma; usuário de cliente não acessa",
    `armazenamento ${st.status} (${st.json?.nodes?.length ?? 0} disco(s)); servidores ${sv.status}; ` +
      `CPU ${host?.cpu_pct ?? "?"}%, memória ${host ? Math.round(((host.mem_total - host.mem_available) / host.mem_total) * 100) : "?"}%, ` +
      `disco do sistema ${host?.system_disk?.pct ?? "?"}%, espera por IO ${host?.io_pressure?.full10 ?? "?"}%; ` +
      `serviços: ${
        Object.entries(svc)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ") || "sem leitura"
      }; cliente: ${denied.status}/${denied2.status}`,
  );
}

async function clean() {
  const t = await admin();
  if (process.env.GESTOR_ID)
    await http("DELETE", `/api/v1/users/${process.env.GESTOR_ID}`, { token: t });
}

try {
  if (stage === "live") await live();
  else if (stage === "api") await apiChecks();
  else if (stage === "clean") await clean();
  else throw new Error(`etapa desconhecida: ${stage}`);
} catch (err) {
  console.log(`ERROR|${err?.message ?? err}`);
}
