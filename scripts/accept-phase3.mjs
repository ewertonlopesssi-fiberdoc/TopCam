/* global process, console, fetch, setTimeout, Buffer */
// TopCam — verificações da Fase 3 (ao vivo) pela API e pelo gateway.
// Executado DENTRO do contêiner "api" por scripts/accept-phase3.sh (Node 22, ffprobe disponível).
//
//   node - setup  → L2–L5 e L7 (endereços, HLS das 5 câmeras, WHEP, segurança, atraso)
//   node - clean  → exclui o visualizador de aceite
//
// Saída: "RESULT|<id>|PASS|FAIL|<critério>|<evidência>" e "OUT|<nome>|<valor>".

import { execFileSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import { writeFileSync } from "node:fs";

const BASE = process.env.BASE ?? "http://gateway";
const RUN = process.env.RUN ?? String(Date.now()).slice(-6);
const ACC_EMAIL = process.env.ACC_EMAIL;
const ACC_PASSWORD = process.env.ACC_PASSWORD;
const PUBLIC_HOST = process.env.PUBLIC_HOST ?? "localhost";
const stage = process.argv[2];
const CODES = ["CAM-001", "CAM-002", "CAM-003", "CAM-004", "CAM-005"];

const out = (k, v) => console.log(`OUT|${k}|${v}`);
function result(id, ok, crit, ev) {
  console.log(`RESULT|${id}|${ok ? "PASS" : "FAIL"}|${crit}|${String(ev).replace(/\|/g, "/")}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(method, path, { token, body, raw, type } = {}) {
  const res = await fetch(path.startsWith("http") ? path : `${BASE}${path}`, {
    method,
    redirect: "manual",
    headers: {
      ...(body !== undefined ? { "content-type": type ?? "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : type ? body : JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  if (!raw) {
    try {
      json = JSON.parse(buf.toString("utf8"));
    } catch {
      /* não é JSON */
    }
  }
  return {
    status: res.status,
    json,
    text: raw ? "" : buf.toString("utf8"),
    buf,
    headers: res.headers,
  };
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
  return t;
}

/** Baixa playlist → variante de vídeo → init + último segmento. */
async function fetchHls(url) {
  const dir = url.slice(0, url.lastIndexOf("/") + 1);
  const idx = await http("GET", url);
  if (idx.status !== 200) return { ok: false, why: `index ${idx.status}` };
  const variant = idx.text.split("\n").find((l) => l && !l.startsWith("#") && /video/.test(l));
  if (!variant) return { ok: false, why: "sem variante de vídeo" };
  const v = await http("GET", dir + variant.trim());
  if (v.status !== 200) return { ok: false, why: `variante ${v.status}` };
  const init = /#EXT-X-MAP:URI="([^"]+)"/.exec(v.text)?.[1];
  const segs = v.text.split("\n").filter((l) => l && !l.startsWith("#"));
  const last = segs.at(-1);
  if (!init || !last) return { ok: false, why: "playlist sem segmentos" };
  const a = await http("GET", dir + init, { raw: true });
  const b = await http("GET", dir + last.trim(), { raw: true });
  if (a.status !== 200 || b.status !== 200)
    return { ok: false, why: `mídia ${a.status}/${b.status}` };
  // Borda ao vivo: última data do programa + duração do que vem depois dela.
  const lines = v.text.split("\n");
  let edge = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^#EXT-X-PROGRAM-DATE-TIME:(.+)$/.exec(lines[i]);
    if (m) {
      edge = Date.parse(m[1]);
      for (
        let j = i + 1;
        j < lines.length && !lines[j].startsWith("#EXT-X-PROGRAM-DATE-TIME");
        j++
      ) {
        const d = /^#EXTINF:([\d.]+)/.exec(lines[j]);
        if (d) edge += Number(d[1]) * 1000;
      }
    }
  }
  // Partes depois do último segmento completo.
  const tail = v.text.slice(v.text.lastIndexOf("#EXTINF"));
  for (const m of tail.matchAll(/#EXT-X-PART:DURATION=([\d.]+)/g)) edge += Number(m[1]) * 1000;
  return { ok: true, bytes: a.buf.length + b.buf.length, mp4: Buffer.concat([a.buf, b.buf]), edge };
}

function probe(file) {
  try {
    const o = execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,codec_name,width,height",
        "-of",
        "json",
        file,
      ],
      { timeout: 15000 },
    );
    return JSON.parse(o.toString()).streams ?? [];
  } catch {
    return [];
  }
}

const OFFER = [
  "v=0",
  "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0",
  "m=video 9 UDP/TLS/RTP/SAVPF 102",
  "c=IN IP4 0.0.0.0",
  "a=rtcp:9 IN IP4 0.0.0.0",
  "a=ice-ufrag:aceite3x",
  "a=ice-pwd:aceitefase3senhaice0123456",
  "a=fingerprint:sha-256 7B:8B:F0:65:5F:78:E2:51:3B:AC:6F:F3:3F:46:1B:35:DC:B8:5F:64:1A:24:C2:43:F0:A1:58:D0:A1:2C:19:08",
  "a=setup:actpass",
  "a=mid:0",
  "a=recvonly",
  "a=rtcp-mux",
  "a=rtpmap:102 H264/90000",
  "a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
  "",
].join("\r\n");

// ---------------------------------------------------------------------------------------------
async function setup() {
  await activate(ACC_EMAIL, process.env.ACC_TEMP, ACC_PASSWORD);
  const admin = await login(ACC_EMAIL, ACC_PASSWORD);
  const all =
    (await http("GET", "/api/v1/cameras?pageSize=100", { token: admin })).json?.items ?? [];
  const alfa = all.filter((c) => c.tenantName === "Empresa Alfa" && CODES.includes(c.code));
  const byCode = Object.fromEntries(alfa.map((c) => [c.code, c]));

  // L2 — endereços temporários
  const s = await http("POST", "/api/v1/live/sessions", {
    token: admin,
    body: { cameraIds: CODES.map((c) => byCode[c]?.id).filter(Boolean) },
  });
  const items = s.json?.items ?? [];
  const prefixes = alfa.map((c) => c.streamKeyPrefix).filter(Boolean);
  const leaks =
    prefixes.filter((p) => s.text.includes(p)).length + (s.text.includes("cam/") ? 1 : 0);
  result(
    "L2",
    s.status === 200 &&
      items.length === 5 &&
      items.every((i) => i.ok && i.hls && i.whep) &&
      leaks === 0,
    "Endereços temporários do ao vivo para as 5 câmeras, sem chave nem caminho interno",
    `${items.filter((i) => i.ok).length}/5 endereços; validade ${items[0]?.expiresAt ?? "?"}; vazamentos de chave/caminho: ${leaks}`,
  );

  // L3 — HLS das 5 câmeras pelo gateway, validado com ffprobe
  const ok = [];
  const ages = [];
  const fails = [];
  for (const it of items) {
    const code = alfa.find((c) => c.id === it.cameraId)?.code;
    let r = { ok: false, why: "não tentou" };
    for (let i = 0; i < 4 && !r.ok; i++) {
      r = await fetchHls(it.hls);
      if (!r.ok) await sleep(2500);
    }
    if (!r.ok) {
      fails.push(`${code}: ${r.why}`);
      continue;
    }
    const f = `/tmp/aceite3-${code}.mp4`;
    writeFileSync(f, r.mp4);
    const v = probe(f).find((x) => x.codec_type === "video");
    if (v) {
      ok.push(`${code} ${v.codec_name} ${v.width}x${v.height}`);
      if (r.edge) ages.push((Date.now() - r.edge) / 1000);
    } else fails.push(`${code}: ffprobe sem vídeo`);
  }
  result(
    "L3",
    ok.length === 5,
    "As 5 câmeras tocam por HLS através do gateway (playlist, init e segmento válidos)",
    ok.length === 5
      ? ok.join("; ")
      : `ok: ${ok.join("; ") || "nenhuma"} · falhas: ${fails.join("; ")}`,
  );

  // L4 — WebRTC (WHEP): negociação e endereço anunciado
  let ip = PUBLIC_HOST;
  try {
    ip = (await lookup(PUBLIC_HOST, { family: 4 })).address;
  } catch {
    /* mantém o nome */
  }
  const w = await http("POST", items[0]?.whep ?? "/live/x/whep", {
    body: OFFER,
    type: "application/sdp",
  });
  const cands = [...w.text.matchAll(/a=candidate:\S+ \d (udp|tcp) \d+ (\S+) (\d+) typ host/g)].map(
    (m) => `${m[1]} ${m[2]}:${m[3]}`,
  );
  const announced = cands.some((c) => c === `udp ${ip}:8189`);
  const internal = cands.filter(
    (c) => /^(udp|tcp) (10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(c) && !c.includes(ip),
  );
  result(
    "L4",
    w.status === 201 && /a=rtpmap:\d+ H264/.test(w.text) && announced,
    "WebRTC (WHEP): negociação pelo gateway e mídia anunciada em PUBLIC_HOST:8189",
    `resposta ${w.status}; candidatos: ${[...new Set(cands)].join(", ") || "nenhum"}${internal.length ? ` (internos: ${internal.length})` : ""}`,
  );

  // L5 — segurança
  const hls = items[1]?.hls ?? "";
  const tampered = hls.replace(/(\/live\/v1\.[^.]+\.)([^/]+)/, "$1AAAA$2");
  const shared = await import("/app/packages/shared/dist/index.js");
  const claims = JSON.parse(Buffer.from(hls.split("/")[2].split(".")[1], "base64url").toString());
  const expired = shared.signLiveToken(process.env.JWT_SECRET, {
    ...claims,
    e: Math.floor(Date.now() / 1000) - 5,
  });
  const direct = await http("GET", `/cam/${claims.c}/index.m3u8`);
  const internalAuth = await http("GET", "/internal/live/auth");
  const r1 = await http("GET", tampered);
  const r2 = await http("GET", `/live/${expired}/index.m3u8?cookieCheck=1`);

  // Visualizador da Empresa Alfa só com a CAM-002.
  const email = `vigia-${RUN}@aceite.invalid`;
  const created = await http("POST", "/api/v1/users", {
    token: admin,
    body: { name: "Vigia Aceite", email, role: "viewer", tenantId: byCode["CAM-002"].tenantId },
  });
  out("VIEWER_ID", created.json?.user?.id ?? "");
  await http("PUT", `/api/v1/users/${created.json?.user?.id}/camera-permissions`, {
    token: admin,
    body: { items: [{ cameraId: byCode["CAM-002"].id, canLive: true }] },
  });
  const viewer = await activate(email, created.json?.temporaryPassword, `Portaria${RUN}Segura`);
  const vOther = await http("POST", `/api/v1/cameras/${byCode["CAM-001"].id}/live`, {
    token: viewer,
  });
  const vMine = await http("POST", `/api/v1/cameras/${byCode["CAM-002"].id}/live`, {
    token: viewer,
  });
  const vPlay = await http("GET", vMine.json?.hls ?? "/x");
  await http("POST", "/api/v1/auth/logout", { token: viewer, body: {} });
  await sleep(6500); // cache do gateway: 5 s
  const vAfter = await http("GET", vMine.json?.hls ?? "/x");
  result(
    "L5",
    r1.status === 403 &&
      r2.status === 403 &&
      direct.status === 404 &&
      internalAuth.status === 404 &&
      vOther.status === 404 &&
      vMine.status === 200 &&
      vPlay.status === 200 &&
      vAfter.status === 403,
    "Token adulterado ou vencido = 403; caminho interno inacessível; visualizador só a câmera liberada; logout corta o vídeo",
    `adulterado=${r1.status}, vencido=${r2.status}, /cam/ direto=${direct.status}, /internal=${internalAuth.status}; visualizador: CAM-001=${vOther.status}, CAM-002=${vMine.status}, vídeo=${vPlay.status}, após logout=${vAfter.status}`,
  );

  // L7 — atraso medido no servidor (HLS)
  const sorted = [...ages].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  result(
    "L7",
    sorted.length > 0 && med < 5,
    "Atraso do HLS na borda do servidor (data do programa × relógio) — informativo",
    sorted.length
      ? `mediana ${med.toFixed(2)} s (${sorted.map((a) => a.toFixed(2)).join(", ")}); a latência na tela é medida no navegador (E2E)`
      : "sem medida",
  );
}

async function clean() {
  const admin = await login(ACC_EMAIL, ACC_PASSWORD);
  if (process.env.VIEWER_ID)
    await http("DELETE", `/api/v1/users/${process.env.VIEWER_ID}`, { token: admin });
}

try {
  if (stage === "setup") await setup();
  else if (stage === "clean") await clean();
  else throw new Error("etapa desconhecida");
} catch (err) {
  console.log(`ERROR|${err.message}`);
  process.exitCode = 1;
}
