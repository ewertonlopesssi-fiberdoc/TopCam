/* global process, console, fetch, Buffer */
// TopCam — verificações da Fase 5 (gravações: calendário, reprodução e exportação).
// Executado DENTRO do contêiner "api" por scripts/accept-phase5.sh (Node 22, ffprobe disponível).
//
//   node - check  → G2–G7 pela API e pelo gateway (porta do painel)
//   node - clean  → exclui o visualizador de aceite
//
// Entrada (ambiente): BASE, ACC_EMAIL, ACC_TEMP/ACC_PASSWORD, CAM1, CAM2, GAP_AT,
//                     EXPORT_MAX_S, MEDIA_READ_USER, MEDIA_READ_PASSWORD.
// Saída: "RESULT|<id>|PASS|FAIL|<critério>|<evidência>" e "OUT|<nome>|<valor>".

import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";

const BASE = process.env.BASE ?? "http://gateway";
const RUN = process.env.RUN ?? String(Date.now()).slice(-6);
const { ACC_EMAIL, ACC_TEMP, ACC_PASSWORD, CAM1, CAM2 } = process.env;
const GAP_AT = Number(process.env.GAP_AT ?? NaN); // instante (ms) em que o transmissor caiu
const EXPORT_MAX_S = Number(process.env.EXPORT_MAX_S ?? 3600);
const stage = process.argv[2];

const out = (k, v) => console.log(`OUT|${k}|${v}`);
function result(id, ok, crit, ev) {
  console.log(`RESULT|${id}|${ok ? "PASS" : "FAIL"}|${crit}|${String(ev).replace(/\|/g, "/")}`);
}
const iso = (ms) => new Date(ms).toISOString();
const q = (ms) => encodeURIComponent(iso(ms));

async function http(method, path, { token, body, headers } = {}) {
  const res = await fetch(path.startsWith("http") ? path : `${BASE}${path}`, {
    method,
    redirect: "manual",
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try {
    json = JSON.parse(buf.toString("utf8"));
  } catch {
    /* vídeo */
  }
  return { status: res.status, json, buf, headers: res.headers };
}

async function login(email, password) {
  const r = await http("POST", "/api/v1/auth/login", { body: { email, password } });
  return r.json?.accessToken;
}
async function activate(email, temp, next) {
  const t = await login(email, temp);
  await http("POST", "/api/v1/auth/change-password", {
    token: t,
    body: { currentPassword: temp, newPassword: next },
  });
  return login(email, next);
}

function probe(buf, name) {
  const f = `/tmp/aceite5-${RUN}-${name}.mp4`;
  writeFileSync(f, buf);
  try {
    const txt = execFileSync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration,format_name:stream=codec_name",
      "-of",
      "compact",
      f,
    ]).toString();
    const codecs = [...txt.matchAll(/codec_name=(\w+)/g)].map((m) => m[1]);
    const dur = Number(/duration=([\d.]+)/.exec(txt)?.[1] ?? 0);
    return { ok: codecs.includes("h264") && dur > 0, codecs, dur };
  } catch {
    return { ok: false, codecs: [], dur: 0 };
  } finally {
    rmSync(f, { force: true });
  }
}

function spansOf(segments) {
  const spans = [];
  for (const s of segments) {
    const from = Date.parse(s.startedAt);
    const to = Date.parse(s.endedAt);
    const last = spans.at(-1);
    if (last && from - last.to <= 1000) last.to = Math.max(last.to, to);
    else spans.push({ from, to });
  }
  return spans;
}

async function check() {
  const admin = ACC_PASSWORD
    ? await login(ACC_EMAIL, ACC_PASSWORD)
    : await activate(ACC_EMAIL, ACC_TEMP, `AceiteFase5-${RUN}-Ok`);
  if (!admin) throw new Error("login do usuário de aceite falhou");
  const A = { token: admin };

  // ------------------------------------------------------------ G2: calendário e linha do tempo
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  const days = await http(
    "GET",
    `/api/v1/cameras/${CAM1}/recordings/days?from=${today.slice(0, 8)}01&to=${today}&tz=America/Sao_Paulo`,
    A,
  );
  const todayItem = days.json?.items?.find((d) => d.day === today);
  const tl = await http(
    "GET",
    `/api/v1/cameras/${CAM1}/recordings?from=${q(Date.now() - 3 * 3600_000)}`,
    A,
  );
  const gap = tl.json?.gaps?.find(
    (g) => Math.abs(Date.parse(g.from) - GAP_AT) < 90_000 && g.seconds >= 20,
  );
  const spans = spansOf(tl.json?.segments ?? []);
  result(
    "G2",
    days.status === 200 && todayItem?.seconds > 0 && tl.status === 200 && gap,
    "Calendário mostra o dia com gravação; a linha do tempo mostra a lacuna da queda",
    `hoje (${today}): ${todayItem ? `${todayItem.segments} segmentos, ${todayItem.seconds} s` : "sem gravação"}; ` +
      `blocos contínuos em 3 h: ${spans.length}; lacuna da queda: ${gap ? `${gap.seconds} s (${gap.from.slice(11, 19)}–${gap.to.slice(11, 19)} UTC)` : "não encontrada"}`,
  );

  // ------------------------------------------------------------ G3: reprodução pelo gateway
  const pb = await http("POST", `/api/v1/cameras/${CAM1}/playback`, A);
  const url = pb.json?.url ?? "";
  // Trecho de 30 s dentro do bloco mais longo, longe das bordas.
  const span = [...spans].sort((a, b) => b.to - b.from - (a.to - a.from))[0];
  const pStart = span ? span.from + 10_000 : Date.now() - 120_000;
  const video = await http("GET", `${url}&start=${q(pStart)}&duration=30`);
  const pv = probe(video.buf, "playback");
  const ok3 =
    pb.status === 200 &&
    /^\/playback\/v1\.[^/]+\/get\?path=cam\/[0-9a-f-]+&format=fmp4$/.test(url) &&
    video.status === 200 &&
    pv.ok &&
    Math.abs(pv.dur - 30) < 3 &&
    video.headers.get("cache-control") === "no-store" &&
    !video.headers.get("set-cookie");
  result(
    "G3",
    ok3,
    "Reprodução pelo gateway com endereço temporário: fMP4 válido do trecho pedido",
    `endereço ${pb.status}; vídeo ${video.status}, ${(video.buf.length / 1e6).toFixed(1)} MB, ${pv.codecs.join("+")}, ${pv.dur.toFixed(1)} s (pedido 30 s); ` +
      `cache ${video.headers.get("cache-control")}; cookie: ${video.headers.get("set-cookie") ? "sim" : "não"}`,
  );

  // ------------------------------------------------------------ G4: segurança da reprodução
  const token = url.split("/")[2] ?? "";
  const live = await http("POST", `/api/v1/cameras/${CAM1}/live`, A);
  const liveToken = (live.json?.hls ?? "").split("/")[2] ?? "";
  const pq = `start=${q(pStart)}&duration=10`;
  const probes = {
    "sem token": await http("GET", `/playback/x/get?path=cam/${CAM1}&${pq}&format=fmp4`),
    adulterado: await http(
      "GET",
      `/playback/${token.slice(0, -2)}xx/get?path=cam/${CAM1}&${pq}&format=fmp4`,
    ),
    "outra câmera": await http("GET", `/playback/${token}/get?path=cam/${CAM2}&${pq}&format=fmp4`),
    "token do ao vivo": await http(
      "GET",
      `/playback/${liveToken}/get?path=cam/${CAM1}&${pq}&format=fmp4`,
    ),
    "lista (/list)": await http("GET", `/playback/${token}/list?path=cam/${CAM1}`),
    "mais de 1 h": await http(
      "GET",
      `/playback/${token}/get?path=cam/${CAM1}&start=${q(pStart)}&duration=7200&format=fmp4`,
    ),
    "formato mp4": await http("GET", `/playback/${token}/get?path=cam/${CAM1}&${pq}&format=mp4`),
    "direto no servidor, sem senha": await http(
      "GET",
      `http://mediamtx:9996/get?path=cam/${CAM1}&${pq}&format=fmp4`,
    ),
  };
  const expect4 = {
    "sem token": 403,
    adulterado: 403,
    "outra câmera": 403,
    "token do ao vivo": 403,
    "lista (/list)": 403,
    "mais de 1 h": 400,
    "formato mp4": 400,
    "direto no servidor, sem senha": 401,
  };
  const bad = Object.entries(probes).filter(([k, r]) => r.status !== expect4[k]);
  result(
    "G4",
    bad.length === 0 && token.length > 20,
    "Reprodução recusada sem token válido, para outra câmera, com token do ao vivo, fora dos limites ou direto no servidor",
    Object.entries(probes)
      .map(([k, r]) => `${k} ${r.status}`)
      .join("; "),
  );

  // ------------------------------------------------------------ G5: permissão por câmera
  const tenantId = (await http("GET", `/api/v1/cameras/${CAM1}`, A)).json?.tenantId;
  const created = await http("POST", "/api/v1/users", {
    ...A,
    body: {
      name: `Aceite5 Vigia ${RUN}`,
      email: `aceite5-vigia-${RUN}@topcam.local`,
      role: "viewer",
      tenantId,
    },
  });
  const viewerId = created.json?.user?.id;
  out("VIEWER_ID", viewerId ?? "");
  const grant = (items) =>
    http("PUT", `/api/v1/users/${viewerId}/camera-permissions`, { ...A, body: { items } });
  await grant([{ cameraId: CAM1, canLive: true }]);
  const V = {
    token: await activate(
      `aceite5-vigia-${RUN}@topcam.local`,
      created.json?.temporaryPassword,
      `Vigia5-${RUN}-Seguro`,
    ),
  };
  const noPb = await http("POST", `/api/v1/cameras/${CAM1}/playback`, V);
  const noDays = await http(
    "GET",
    `/api/v1/cameras/${CAM1}/recordings/days?from=${today}&to=${today}`,
    V,
  );
  await grant([{ cameraId: CAM1, canLive: true, canPlayback: true }]);
  const vPb = await http("POST", `/api/v1/cameras/${CAM1}/playback`, V);
  const vUrl = `${vPb.json?.url}&start=${q(pStart)}&duration=5`;
  const vOk = await http("GET", vUrl);
  const vOther = await http("POST", `/api/v1/cameras/${CAM2}/playback`, V);
  await grant([{ cameraId: CAM1, canLive: true }]);
  const vRevoked = await http("GET", vUrl);
  result(
    "G5",
    noPb.status === 404 &&
      noDays.status === 404 &&
      vPb.status === 200 &&
      vOk.status === 200 &&
      vOther.status === 404 &&
      vRevoked.status === 403,
    'Visualizador: sem "pode reproduzir" nada; com ela só a câmera liberada; retirada corta o endereço já emitido',
    `só ao vivo: reprodução ${noPb.status}, calendário ${noDays.status}; com permissão: ${vPb.status}, vídeo ${vOk.status}; ` +
      `outra câmera ${vOther.status}; após retirar: ${vRevoked.status}`,
  );

  // ------------------------------------------------------------ G6: exportação MP4 auditada
  await grant([{ cameraId: CAM1, canLive: true, canPlayback: true }]);
  const eStart = span ? span.from + 5_000 : Date.now() - 180_000;
  const body = { start: iso(eStart), end: iso(eStart + 120_000) };
  const vDenied = await http("POST", `/api/v1/cameras/${CAM1}/exports`, { ...V, body });
  const tooLong = await http("POST", `/api/v1/cameras/${CAM1}/exports`, {
    ...A,
    body: { start: iso(Date.now() - (EXPORT_MAX_S + 120) * 1000), end: iso(Date.now() - 60_000) },
  });
  const future = await http("POST", `/api/v1/cameras/${CAM1}/exports`, {
    ...A,
    body: { start: iso(Date.now()), end: iso(Date.now() + 300_000) },
  });
  const none = await http("POST", `/api/v1/cameras/${CAM1}/exports`, {
    ...A,
    body: { start: "2020-01-01T00:00:00Z", end: "2020-01-01T00:05:00Z" },
  });
  const ex = await http("POST", `/api/v1/cameras/${CAM1}/exports`, { ...A, body });
  const dl = await http("GET", ex.json?.downloadUrl ?? "/api/v1/exports/x");
  const pe = probe(dl.buf, "export");
  const disp = dl.headers.get("content-disposition") ?? "";
  const forged = await http("GET", `${ex.json?.downloadUrl ?? ""}x`);
  const audit = await http("GET", "/api/v1/audit-logs?action=camera.export&pageSize=10", A);
  const acts = (audit.json?.items ?? []).map((i) => i.action);
  const ok6 =
    vDenied.status === 403 &&
    tooLong.status === 400 &&
    future.status === 400 &&
    none.status === 404 &&
    ex.status === 200 &&
    dl.status === 200 &&
    pe.ok &&
    Math.abs(pe.dur - 120) < 4 &&
    /filename="CAM-001_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_2min\.mp4"/.test(disp) &&
    forged.status === 403 &&
    acts.includes("camera.export_requested") &&
    acts.includes("camera.exported");
  result(
    "G6",
    ok6,
    'Exportação MP4 só com "pode exportar", com limites, arquivo válido e registro na auditoria',
    `sem permissão ${vDenied.status}; acima do máximo ${tooLong.status}; futuro ${future.status}; sem gravação ${none.status}; ` +
      `pedido ${ex.status}; download ${dl.status} ${(dl.buf.length / 1e6).toFixed(1)} MB ${pe.codecs.join("+")} ${pe.dur.toFixed(1)} s (pedido 120 s); ` +
      `${/filename="([^"]+)"/.exec(disp)?.[1] ?? "sem nome"}; link adulterado ${forged.status}; auditoria: ${[...new Set(acts)].join(", ") || "nada"}`,
  );

  // ------------------------------------------------------------ G7: exportação atravessando a lacuna
  if (!gap) {
    result(
      "G7",
      false,
      "Exportação que atravessa uma lacuna traz todos os trechos gravados",
      "sem lacuna de teste",
    );
  } else {
    const gb = { start: iso(Date.parse(gap.from) - 60_000), end: iso(Date.parse(gap.to) + 60_000) };
    const gx = await http("POST", `/api/v1/cameras/${CAM1}/exports`, { ...A, body: gb });
    const gd = await http("GET", gx.json?.downloadUrl ?? "/api/v1/exports/x");
    const pg = probe(gd.buf, "gap");
    const rec = gx.json?.recordedSeconds ?? 0;
    result(
      "G7",
      gx.status === 200 &&
        gd.status === 200 &&
        pg.ok &&
        rec < gx.json.seconds &&
        Math.abs(pg.dur - rec) < 4,
      "Exportação que atravessa uma lacuna traz todos os trechos gravados (lacuna removida do arquivo)",
      `trecho ${gx.json?.seconds ?? "?"} s, gravado ${rec} s; arquivo ${gd.status}, ${pg.codecs.join("+")}, ${pg.dur.toFixed(1)} s`,
    );
  }
}

async function clean() {
  const admin = await login(ACC_EMAIL, ACC_PASSWORD ?? `AceiteFase5-${RUN}-Ok`);
  if (process.env.VIEWER_ID && admin)
    await http("DELETE", `/api/v1/users/${process.env.VIEWER_ID}`, { token: admin });
}

try {
  if (stage === "check") await check();
  else if (stage === "clean") await clean();
  else throw new Error(`etapa desconhecida: ${stage}`);
} catch (err) {
  console.log(`ERROR|${err?.message ?? err}`);
}
