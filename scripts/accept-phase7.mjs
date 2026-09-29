/* global process, console, fetch, Buffer, setTimeout */
// TopCam — verificações pela API e pelo gateway da Fase 7 (monitoramento).
// Executado DENTRO do contêiner "api" por scripts/accept-phase7.sh.
//
//   node - prom        → M1: Prometheus coletando (alvos no ar)
//   node - smtp        → M2: Integrações → e-mail (salvar, senha nunca devolvida, teste chega)
//   node - mail        → espera um e-mail no Mailpit (SUBJECT, SINCE, TIMEOUT) → OUT|MAIL|...
//   node - alerts      → M5: listar, reconhecer, resolver (auditoria) e isolamento por cliente
//   node - reports     → M6: dashboard, relatório (JSON e CSV), eventos com filtro, acesso do cliente
//   node - clean       → exclui os usuários de cliente de teste
//
// Saída: "OUT|<nome>|<valor>" e "RESULT|<id>|PASS|FAIL|<critério>|<evidência>".

const BASE = process.env.BASE ?? "http://gateway";
const MAILPIT = process.env.MAILPIT ?? "http://mailpit:8025";
const RUN = process.env.RUN ?? String(Date.now()).slice(-6);
const { ACC_EMAIL, ACC_TEMP, CAM1, ALFA, SOL, MAIL_TO } = process.env;
const PASSWORD = `AceiteFase7-${RUN}-Ok`;
const stage = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const out = (k, v) => console.log(`OUT|${k}|${String(v).replace(/\|/g, "/")}`);
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
  return { status: res.status, json, text: buf.toString("utf8"), headers: res.headers };
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

/** Cria um gestor (tenant_admin) no cliente e devolve { id, token }. */
async function gestor(t, tenantId, tag) {
  const email = `aceite7-${tag}-${RUN}@topcam.local`;
  const c = await http("POST", "/api/v1/users", {
    token: t,
    body: { name: `Aceite7 ${tag} ${RUN}`, email, role: "tenant_admin", tenantId },
  });
  const temp = c.json?.temporaryPassword;
  const next = `Gestao7-${tag}-${RUN}-Segura`;
  const t0 = await login(email, temp);
  await http("POST", "/api/v1/auth/change-password", {
    token: t0,
    body: { currentPassword: temp, newPassword: next },
  });
  out(`GESTOR_${tag.toUpperCase()}`, c.json?.user?.id ?? "");
  return { id: c.json?.user?.id, token: await login(email, next) };
}

// ------------------------------------------------------------------ Mailpit
async function findMail(subjectPart, sinceMs) {
  const r = await http("GET", `${MAILPIT}/api/v1/messages?limit=100`);
  return (r.json?.messages ?? []).find(
    (m) =>
      m.Subject?.includes(subjectPart) &&
      Date.parse(m.Created) >= sinceMs - 2000 &&
      (m.To ?? []).some((x) => x.Address === MAIL_TO),
  );
}

async function mail() {
  const subject = process.env.SUBJECT;
  const since = Number(process.env.SINCE) * 1000;
  const timeout = Number(process.env.TIMEOUT ?? 60) * 1000;
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const m = await findMail(subject, since);
    if (m) {
      const full = await http("GET", `${MAILPIT}/api/v1/message/${m.ID}`);
      out("MAIL", `${Math.round((Date.parse(m.Created) - since) / 1000)} ${m.Subject}`);
      out("MAILBODY", (full.json?.Text ?? "").replace(/\s+/g, " ").slice(0, 300));
      return;
    }
    await sleep(2000);
  }
  out("MAIL", "");
}

// ------------------------------------------------------------------ M1
async function prom() {
  let targets = [];
  for (let i = 0; i < 20; i++) {
    const r = await http("GET", "http://prometheus:9090/api/v1/targets?state=active");
    targets = r.json?.data?.activeTargets ?? [];
    if (targets.length >= 3 && targets.every((x) => x.health === "up")) break;
    await sleep(5000);
  }
  const q = await http(
    "GET",
    `http://prometheus:9090/api/v1/query?query=${encodeURIComponent("node_filesystem_avail_bytes")}`,
  );
  const series = q.json?.data?.result?.length ?? 0;
  const jobs = targets.map((x) => `${x.labels?.job}=${x.health}`).join(", ");
  result(
    "M1",
    targets.length >= 3 && targets.every((x) => x.health === "up") && series > 0,
    "Prometheus coleta o servidor (node-exporter), o servidor de mídia e a si mesmo",
    `alvos: ${jobs || "nenhum"}; séries de disco: ${series}`,
  );
}

// ------------------------------------------------------------------ M2
async function smtp() {
  const t = await admin();
  const secret = `SenhaSecreta-${RUN}`;
  const bad = await http("PUT", "/api/v1/integrations/smtp", {
    token: t,
    body: {
      enabled: true,
      host: "mailpit",
      port: 1025,
      security: "none",
      username: "sem-senha@topcam.local",
      password: "",
      fromName: "TopCam Aceite",
      fromEmail: "topcam@aceite.local",
      recipients: MAIL_TO,
      minSeverity: "error",
      notifyResolved: true,
    },
  });
  // Grava primeiro com usuário e senha (para provar que a senha não volta), depois sem.
  const withPwd = await http("PUT", "/api/v1/integrations/smtp", {
    token: t,
    body: {
      enabled: false,
      host: "mailpit",
      port: 1025,
      security: "none",
      username: "usuario@topcam.local",
      password: secret,
      fromName: "TopCam Aceite",
      fromEmail: "topcam@aceite.local",
      recipients: MAIL_TO,
      minSeverity: "error",
      notifyResolved: true,
    },
  });
  const g1 = await http("GET", "/api/v1/integrations", { token: t });
  const leaked = g1.text.includes(secret) || /password_enc/.test(g1.text);
  const save = await http("PUT", "/api/v1/integrations/smtp", {
    token: t,
    body: {
      enabled: true,
      host: "mailpit",
      port: 1025,
      security: "none",
      username: "",
      password: "",
      fromName: "TopCam Aceite",
      fromEmail: "topcam@aceite.local",
      recipients: MAIL_TO,
      minSeverity: "error",
      notifyResolved: true,
    },
  });
  const since = Date.now();
  const test = await http("POST", "/api/v1/integrations/smtp/test", { token: t, body: {} });
  let m = null;
  for (let i = 0; i < 10 && !m; i++) {
    m = await findMail("[TopCam] E-mail de teste", since);
    if (!m) await sleep(1000);
  }
  const g2 = await http("GET", "/api/v1/integrations", { token: t });
  const logged = (g2.json?.notifications ?? []).find((n) => n.kind === "test");
  result(
    "M2",
    bad.status === 400 &&
      withPwd.status === 200 &&
      g1.json?.smtp?.hasPassword === true &&
      !leaked &&
      save.status === 200 &&
      test.status === 200 &&
      !!m &&
      logged?.status === "sent",
    "Integrações → e-mail: validação, senha cifrada e nunca devolvida, e-mail de teste entregue e registrado",
    `sem senha → ${bad.status} (${bad.json?.message ?? ""}); com senha → ${withPwd.status}, hasPassword=${g1.json?.smtp?.hasPassword}, senha na resposta: ${leaked ? "SIM" : "não"}; ` +
      `teste → ${test.status}, chegou: ${m ? "sim" : "não"}; registro: ${logged?.status ?? "nenhum"}`,
  );
}

// ------------------------------------------------------------------ M5
async function alerts() {
  const t = await admin();
  const id = process.env.ALERT_ID;
  const list = await http("GET", `/api/v1/alerts?status=active&cameraId=${CAM1}&pageSize=50`, {
    token: t,
  });
  const listed = (list.json?.items ?? []).some((a) => a.id === id);
  const summary = await http("GET", "/api/v1/alerts/summary", { token: t });
  const alfa = await gestor(t, ALFA, "alfa");
  const sol = await gestor(t, SOL, "sol");
  const seenAlfa = (
    await http("GET", "/api/v1/alerts?status=all&pageSize=100", { token: alfa.token })
  ).json?.items?.some((a) => a.id === id);
  const solList = await http("GET", "/api/v1/alerts?status=all&pageSize=100", {
    token: sol.token,
  });
  const seenSol = solList.json?.items?.some((a) => a.id === id);
  const solAck = await http("POST", `/api/v1/alerts/${id}/ack`, { token: sol.token });
  const ack = await http("POST", `/api/v1/alerts/${id}/ack`, { token: alfa.token });
  const afterAck = (
    await http("GET", `/api/v1/alerts?status=acknowledged&cameraId=${CAM1}`, { token: t })
  ).json?.items?.find((a) => a.id === id);
  const res = await http("POST", `/api/v1/alerts/${id}/resolve`, { token: t });
  const afterRes = (
    await http("GET", `/api/v1/alerts?status=resolved&cameraId=${CAM1}`, { token: t })
  ).json?.items?.find((a) => a.id === id);
  const audit = await http("GET", "/api/v1/audit-logs?search=alert.&pageSize=20", { token: t });
  const actions = (audit.json?.items ?? []).filter((e) => e.entityId === id).map((e) => e.action);
  result(
    "M5",
    list.status === 200 &&
      listed &&
      summary.status === 200 &&
      seenAlfa === true &&
      solList.status === 200 &&
      seenSol === false &&
      solAck.status === 404 &&
      ack.status === 200 &&
      afterAck?.acknowledgedBy &&
      res.status === 200 &&
      afterRes?.resolvedBy &&
      actions.includes("alert.acknowledged") &&
      actions.includes("alert.resolved"),
    "Alertas: lista e filtros; reconhecer e resolver com autoria e auditoria; outro cliente não vê nem mexe",
    `listado: ${listed}; ativos no sino: ${summary.json?.total ?? "?"}; Alfa vê: ${seenAlfa}; Sol vê: ${seenSol} (reconhecer → ${solAck.status}); ` +
      `reconhecido por ${afterAck?.acknowledgedBy ?? "?"} (${ack.status}); resolvido por ${afterRes?.resolvedBy ?? "?"} (${res.status}); auditoria: ${actions.join(", ") || "nenhuma"}`,
  );
}

// ------------------------------------------------------------------ M6
async function reports() {
  const t = await admin();
  const dash = await http("GET", "/api/v1/dashboard", { token: t });
  const to = new Date();
  const from = new Date(to.getTime() - 86400_000);
  const qs = `from=${from.toISOString()}&to=${to.toISOString()}`;
  const rep = await http("GET", `/api/v1/reports/availability?${qs}`, { token: t });
  const cam = (rep.json?.items ?? []).find((r) => r.cameraId === CAM1);
  const csv = await http("GET", `/api/v1/reports/availability?${qs}&format=csv`, { token: t });
  const csvOk =
    csv.status === 200 &&
    /text\/csv/.test(csv.headers.get("content-type") ?? "") &&
    csv.text.replace(/^\uFEFF/, "").startsWith("Cliente;Câmera;Nome;Disponibilidade (%)");
  const since = process.env.T_START_ISO;
  const ev = await http(
    "GET",
    `/api/v1/events?type=stream_offline&cameraId=${CAM1}&from=${encodeURIComponent(since)}&pageSize=10`,
    { token: t },
  );
  const alfa = await gestor(t, ALFA, "rel");
  const repA = await http("GET", `/api/v1/reports/availability?${qs}`, { token: alfa.token });
  const foreign = (repA.json?.items ?? []).filter((r) => r.tenantName !== "Empresa Alfa").length;
  const integ = await http("GET", "/api/v1/integrations", { token: alfa.token });
  const dashA = await http("GET", "/api/v1/dashboard", { token: alfa.token });
  result(
    "M6",
    dash.status === 200 &&
      dash.json?.cameras?.total >= 1 &&
      (dash.json?.samples?.length ?? 0) >= 1 &&
      rep.status === 200 &&
      cam?.observedS > 0 &&
      csvOk &&
      ev.status === 200 &&
      ev.json?.total >= 1 &&
      repA.status === 200 &&
      (repA.json?.items?.length ?? 0) >= 1 &&
      foreign === 0 &&
      integ.status === 403 &&
      dashA.status === 200 &&
      dashA.json?.storage === undefined,
    "Dashboard, relatório de disponibilidade (JSON e CSV) e eventos com filtro; cliente só vê o que é dele",
    `dashboard: ${dash.json?.cameras?.total ?? "?"} câmeras, ${dash.json?.samples?.length ?? 0} amostra(s) 24 h, ${dash.json?.usersOnline?.web ?? "?"} usuário(s) web; ` +
      `CAM-001 em 24 h: ${cam ? `${cam.availabilityPct}% no ar (${cam.onlineS}/${cam.observedS} s), ${cam.offlineEvents} queda(s)` : "ausente"}; CSV: ${csvOk ? "ok" : `falhou (${csv.status})`}; ` +
      `eventos "saiu do ar" da CAM-001 no aceite: ${ev.json?.total ?? "?"}; cliente: ${repA.json?.items?.length ?? 0} câmera(s), de outros ${foreign}, integrações ${integ.status}, disco no dashboard: ${dashA.json?.storage === undefined ? "oculto" : "visível"}`,
  );
}

async function clean() {
  const t = await admin();
  for (const id of (process.env.GESTORES ?? "").split(",").filter(Boolean))
    await http("DELETE", `/api/v1/users/${id}`, { token: t });
}

try {
  if (stage === "prom") await prom();
  else if (stage === "smtp") await smtp();
  else if (stage === "mail") await mail();
  else if (stage === "alerts") await alerts();
  else if (stage === "reports") await reports();
  else if (stage === "clean") await clean();
  else throw new Error(`etapa desconhecida: ${stage}`);
} catch (err) {
  console.log(`ERROR|${err?.message ?? err}`);
}
