import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createPool, type Pool } from "@topcam/db";
import {
  encryptSecret,
  parseEncryptionKey,
  sendMail,
  type MailMessage,
  type MediaMtxClient,
} from "@topcam/shared";
import { pino } from "pino";
import { SMTPServer } from "smtp-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, ownerQuery, type TestDb } from "../../../packages/db/test/helpers.js";
import type { WorkerContext } from "../src/context.js";
import { loadEnv } from "../src/env.js";
import {
  accumulateHourly,
  checkCameraAlerts,
  newMonitorState,
  notifyAlerts,
  sampleStatus,
} from "../src/jobs/monitor.js";

/**
 * Monitoramento (Fase 7): alertas de câmera, disponibilidade por hora, amostras do
 * dashboard e e-mail de alertas — este último contra um servidor SMTP real (local),
 * com usuário e senha, como o Gmail exige.
 */

let db: TestDb;
let pool: Pool;
let ctx: WorkerContext;
let cam1: string;
let cam2: string;
let tenant: string;
let smtp: SMTPServer;
let smtpPort = 0;
const inbox: Array<{ to: string; subject: string; body: string }> = [];

async function setSmtp(v: Record<string, unknown>) {
  await ownerQuery(
    db,
    "UPDATE system_settings SET value = value || $1::jsonb WHERE key = 'integrations.smtp'",
    [JSON.stringify(v)],
  );
}
const alerts = () =>
  ownerQuery<{
    rule: string;
    severity: string;
    status: string;
    camera_id: string | null;
    tenant_id: string | null;
  }>(db, "SELECT rule, severity, status, camera_id, tenant_id FROM alerts ORDER BY id");

beforeAll(async () => {
  smtp = new SMTPServer({
    authOptional: false,
    disabledCommands: ["STARTTLS"],
    onAuth(auth, _s, cb) {
      if (auth.username === "alertas@teste.local" && auth.password === "senha-de-app-123")
        return cb(null, { user: auth.username });
      return cb(new Error("535 5.7.8 Username and Password not accepted"));
    },
    onData(stream, session, cb) {
      let raw = "";
      stream.on("data", (d: Buffer) => (raw += d.toString()));
      stream.on("end", () => {
        inbox.push({
          to: session.envelope.rcptTo.map((r) => r.address).join(","),
          subject: subjectOf(raw),
          // Corpo em quoted-printable: tira as quebras "moles" e decodifica os bytes.
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
  ctx = {
    env: loadEnv({
      DATABASE_URL: db.appUrl,
      REDIS_URL: "redis://unused",
      MEDIA_READ_PASSWORD: randomBytes(16).toString("hex"),
      STREAM_KEY_ENC_KEY: db.encKeyB64,
      JWT_SECRET: randomBytes(32).toString("hex"),
      RECORDING_STALL_S: "120",
      PANEL_URL: "http://painel.teste",
    }),
    pool,
    mediamtx: {} as MediaMtxClient,
    log: pino({ level: "silent" }),
    encKey: parseEncryptionKey(db.encKeyB64),
    runProbe: async () => ({}),
  };
  const rows = await ownerQuery<{ id: string; code: string; tenant_id: string }>(
    db,
    `SELECT c.id, c.code, c.tenant_id FROM cameras c JOIN tenants t ON t.id = c.tenant_id WHERE t.slug = 'empresa-alfa'`,
  );
  cam1 = rows.find((r) => r.code === "CAM-001")!.id;
  cam2 = rows.find((r) => r.code === "CAM-002")!.id;
  tenant = rows[0]!.tenant_id;
});

afterAll(async () => {
  await pool?.end();
  await db?.drop();
  await new Promise<void>((r) => smtp?.close(() => r()));
});

beforeEach(async () => {
  await ownerQuery(db, "DELETE FROM notifications");
  await ownerQuery(db, "DELETE FROM alerts");
  await ownerQuery(
    db,
    "UPDATE cameras SET status = 'aguardando_transmissao', enabled = true, recording_enabled = false",
  );
  inbox.length = 0;
  await setSmtp({
    enabled: false,
    host: "127.0.0.1",
    port: smtpPort,
    security: "none",
    username: "alertas@teste.local",
    password_enc: encryptSecret("senha-de-app-123", ctx.encKey),
    from_email: "alertas@teste.local",
    recipients: ["noc@teste.local"],
    min_severity: "error",
    notify_resolved: true,
  });
});

/** Assunto do e-mail bruto: desdobra as linhas e junta os bytes das partes codificadas (RFC 2047). */
function subjectOf(raw: string): string {
  const m = /^Subject:(.*(?:\r?\n[ \t].*)*)/im.exec(raw);
  const value = (m?.[1] ?? "").replace(/\r?\n[ \t]/g, " ").trim();
  const words = [...value.matchAll(/=\?utf-8\?([BQ])\?([^?]*)\?=/gi)];
  if (!words.length) return value;
  const bytes = Buffer.concat(
    words.map(([, enc, txt]) =>
      enc!.toUpperCase() === "B"
        ? Buffer.from(txt!, "base64")
        : Buffer.from(
            txt!
              .replace(/_/g, " ")
              .replace(/=([0-9A-F]{2})/gi, (_x, h: string) => String.fromCharCode(parseInt(h, 16))),
            "latin1",
          ),
    ),
  );
  return bytes.toString("utf8");
}

describe("alertas de câmera", () => {
  it("câmera sem sinal abre alerta (com cliente e câmera) e fecha quando volta", async () => {
    await ownerQuery(
      db,
      "UPDATE cameras SET status = 'offline', status_changed_at = now() WHERE id = $1",
      [cam1],
    );
    expect(await checkCameraAlerts(ctx)).toEqual({ opened: 1, resolved: 0 });
    expect(await checkCameraAlerts(ctx)).toEqual({ opened: 0, resolved: 0 }); // sem duplicar
    expect(await alerts()).toMatchObject([
      {
        rule: "camera_offline",
        severity: "error",
        status: "open",
        camera_id: cam1,
        tenant_id: tenant,
      },
    ]);
    await ownerQuery(db, "UPDATE cameras SET status = 'ao_vivo' WHERE id = $1", [cam1]);
    expect(await checkCameraAlerts(ctx)).toEqual({ opened: 0, resolved: 1 });
    expect((await alerts())[0]!.status).toBe("resolved");
  });

  it("câmera desativada não alerta", async () => {
    await ownerQuery(db, "UPDATE cameras SET status = 'offline', enabled = false WHERE id = $1", [
      cam2,
    ]);
    expect((await checkCameraAlerts(ctx)).opened).toBe(0);
  });

  it("ao vivo sem confirmar gravação alerta; volta a gravar e fecha", async () => {
    await ownerQuery(
      db,
      `UPDATE cameras SET status = 'ao_vivo', recording_enabled = true, last_durable_segment_at = now() - interval '10 minutes',
              status_changed_at = now() - interval '10 minutes' WHERE id = $1`,
      [cam1],
    );
    await checkCameraAlerts(ctx);
    expect(await alerts()).toMatchObject([{ rule: "recording_stalled", status: "open" }]);
    await ownerQuery(db, "UPDATE cameras SET status = 'gravando' WHERE id = $1", [cam1]);
    await checkCameraAlerts(ctx);
    expect((await alerts())[0]!.status).toBe("resolved");
  });
});

describe("disponibilidade e amostras", () => {
  it("soma segundos por câmera e hora; no ar e gravando separados", async () => {
    await ownerQuery(db, "DELETE FROM camera_hourly");
    await ownerQuery(db, "UPDATE cameras SET status = 'gravando' WHERE id = $1", [cam1]);
    await ownerQuery(db, "UPDATE cameras SET status = 'offline' WHERE id = $1", [cam2]);
    const st = newMonitorState();
    const t0 = Date.parse("2026-09-29T10:10:00Z");
    await accumulateHourly(ctx, st, t0);
    await accumulateHourly(ctx, st, t0 + 60_000);
    const rows = await ownerQuery<{
      camera_id: string;
      observed_s: number;
      online_s: number;
      recording_s: number;
    }>(
      db,
      "SELECT camera_id, observed_s, online_s, recording_s FROM camera_hourly WHERE camera_id = ANY($1)",
      [[cam1, cam2]],
    );
    expect(rows.find((r) => r.camera_id === cam1)).toMatchObject({
      observed_s: 120,
      online_s: 120,
      recording_s: 120,
    });
    expect(rows.find((r) => r.camera_id === cam2)).toMatchObject({
      observed_s: 120,
      online_s: 0,
      recording_s: 0,
    });
  });

  it("amostra total e por cliente, com tráfego recebido (bits/s)", async () => {
    await ownerQuery(db, "DELETE FROM status_samples");
    await ownerQuery(db, "UPDATE cameras SET status = 'ao_vivo' WHERE id = $1", [cam1]);
    const st = newMonitorState();
    await ownerQuery(db, `UPDATE ingest_nodes SET metrics = '{"bytes_received_total": 1000000}'`);
    await sampleStatus(ctx, st, 1_000_000);
    await ownerQuery(db, `UPDATE ingest_nodes SET metrics = '{"bytes_received_total": 1750000}'`);
    await sampleStatus(ctx, st, 1_300_000); // +750 kB em 300 s = 20 kbit/s
    const total = await ownerQuery<{ online: number; ingress_bps: string | null }>(
      db,
      "SELECT online, ingress_bps FROM status_samples WHERE tenant_id IS NULL ORDER BY id",
    );
    expect(total).toHaveLength(2);
    expect(Number(total[1]!.ingress_bps)).toBe(20000);
    const alfa = await ownerQuery<{ online: number }>(
      db,
      "SELECT online FROM status_samples WHERE tenant_id = $1",
      [tenant],
    );
    expect(alfa[0]!.online).toBe(1);
  });
});

describe("e-mail de alertas (servidor SMTP real, com senha)", () => {
  const open = (rule: string, severity: string, title: string) =>
    ownerQuery(
      db,
      `INSERT INTO alerts (rule, severity, title, dedup_key) VALUES ($1, $2, $3, $4)`,
      [rule, severity, title, `${rule}:${randomBytes(3).toString("hex")}`],
    );

  it("desligado não envia; ligado envia um e-mail por alerta acima da gravidade mínima, uma vez", async () => {
    await open("camera_offline", "error", "CAM-001 · Entrada: câmera sem sinal");
    await open("storage_level", "warning", "Disco em 72%");
    expect((await notifyAlerts(ctx, newMonitorState())).sent).toBe(0);
    await setSmtp({ enabled: true });
    const st = newMonitorState();
    expect(await notifyAlerts(ctx, st)).toMatchObject({ sent: 1, failed: 0, alerts: 1 });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.to).toBe("noc@teste.local");
    expect(inbox[0]!.subject).toContain("ERRO: CAM-001 · Entrada: câmera sem sinal");
    expect(inbox[0]!.body).toContain("http://painel.teste/eventos");
    expect((await notifyAlerts(ctx, st)).sent).toBe(0);
    const n = await ownerQuery<{ status: string; kind: string }>(
      db,
      "SELECT status, kind FROM notifications",
    );
    expect(n).toEqual([{ status: "sent", kind: "alert" }]);
  });

  it("alerta que piora é avisado de novo; resolvido gera aviso de normalização", async () => {
    await setSmtp({ enabled: true });
    await open("storage_level", "error", "Disco em 86%");
    const st = newMonitorState();
    await notifyAlerts(ctx, st);
    await ownerQuery(db, "UPDATE alerts SET severity = 'critical', title = 'Disco em 96%'");
    await notifyAlerts(ctx, st);
    await ownerQuery(db, "UPDATE alerts SET status = 'resolved', resolved_at = now()");
    await notifyAlerts(ctx, st);
    expect(inbox.map((m) => m.subject)).toEqual([
      "[TopCam] ERRO: Disco em 86%",
      "[TopCam] CRÍTICO: Disco em 96%",
      "[TopCam] Resolvido: Disco em 96%",
    ]);
  });

  it("muitos alertas de uma vez viram um resumo único", async () => {
    await setSmtp({ enabled: true });
    for (let i = 1; i <= 7; i++)
      await open("camera_offline", "error", `CAM-00${i}: câmera sem sinal`);
    const r = await notifyAlerts(ctx, newMonitorState());
    expect(r).toMatchObject({ sent: 1, alerts: 7 });
    expect(inbox[0]!.subject).toBe("[TopCam] 7 alertas abertos (pior: ERRO)");
  });

  it("senha recusada: registra a falha em português e espera 5 min para tentar de novo", async () => {
    await setSmtp({ enabled: true, password_enc: encryptSecret("senha-errada", ctx.encKey) });
    await open("camera_offline", "critical", "CAM-001: câmera sem sinal");
    const st = newMonitorState();
    const now = Date.now();
    expect(await notifyAlerts(ctx, st, { now })).toMatchObject({ sent: 0, failed: 1 });
    const [n] = await ownerQuery<{ status: string; error: string }>(
      db,
      "SELECT status, error FROM notifications",
    );
    expect(n!.status).toBe("failed");
    expect(n!.error).toContain("senha de app");
    expect(await notifyAlerts(ctx, st, { now: now + 60_000 })).toMatchObject({
      sent: 0,
      failed: 0,
    });
    await setSmtp({ password_enc: encryptSecret("senha-de-app-123", ctx.encKey) });
    expect(await notifyAlerts(ctx, st, { now: now + 6 * 60_000 })).toMatchObject({ sent: 1 });
  });

  it("sendMail direto: destinatários e remetente", async () => {
    const s = {
      enabled: true,
      host: "127.0.0.1",
      port: smtpPort,
      security: "none" as const,
      username: "alertas@teste.local",
      password_enc: encryptSecret("senha-de-app-123", ctx.encKey),
      from_name: "TopCam",
      from_email: "alertas@teste.local",
      recipients: [],
      min_severity: "error" as const,
      notify_resolved: true,
    };
    const msg: MailMessage = { to: ["a@x.local", "b@x.local"], subject: "Oi", text: "corpo" };
    await sendMail(s, ctx.encKey, msg);
    expect(inbox.at(-1)!.to).toBe("a@x.local,b@x.local");
    expect(inbox.at(-1)!.body).toContain("From: TopCam <alertas@teste.local>");
  });
});
