import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PLATFORM,
  createPool,
  keepMotionSegments,
  markSegmentVerified,
  recordMotionHit,
  upsertSegmentStart,
  withScope,
  type Pool,
} from "@topcam/db";
import {
  encryptSecret,
  hashSmtpPassword,
  parseEncryptionKey,
  sendMail,
  type MailMessage,
  type MediaMtxClient,
  type SmtpSettings,
} from "@topcam/shared";
import { pino } from "pino";
import type { SMTPServer } from "smtp-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, ownerQuery, type TestDb } from "../../../packages/db/test/helpers.js";
import type { WorkerContext } from "../src/context.js";
import { loadEnv } from "../src/env.js";
import { createEventsSmtpServer } from "../src/events/smtp.js";
import { processAlarms } from "../src/jobs/motion.js";
import { applyRetention } from "../src/jobs/recordings.js";
import { CameraDetector } from "../src/motion/detector.js";

/**
 * Movimento e alarme:
 *  - receptor de eventos por e-mail (SMTP real, como a câmera envia);
 *  - gravação só com movimento (mantém o que teve movimento, apaga o resto, sem lacuna falsa);
 *  - alarme (horário, intervalo mínimo, destinatários);
 *  - detector do servidor com ffmpeg de verdade.
 */

let db: TestDb;
let pool: Pool;
let ctx: WorkerContext;
let server: SMTPServer;
let port = 0;
let cam1: string;
let cam2: string;
let tenant: string;
let recDir: string;
const USER = "camtesteabc12";
const PASS = "SenhaDeEventos123456789X";

function camSmtp(user: string, password: string): SmtpSettings {
  return {
    enabled: true,
    host: "127.0.0.1",
    port,
    security: "none",
    username: user,
    password_enc: encryptSecret(password, ctx.encKey),
    from_name: "Camera",
    from_email: "camera@local",
    recipients: [],
    min_severity: "error",
    notify_resolved: false,
  };
}
const sendAsCamera = (subject: string, user = USER, password = PASS) =>
  sendMail(camSmtp(user, password), ctx.encKey, {
    to: ["eventos@topcam.local"],
    subject,
    text: "Alarm Event\nChannel: 1",
  });

beforeAll(async () => {
  db = await createTestDb();
  pool = createPool(db.appUrl, 4);
  recDir = mkdtempSync(join(tmpdir(), "topcam-mov-"));
  ctx = {
    env: loadEnv({
      DATABASE_URL: db.appUrl,
      REDIS_URL: "redis://unused",
      MEDIA_READ_PASSWORD: randomBytes(16).toString("hex"),
      STREAM_KEY_ENC_KEY: db.encKeyB64,
      JWT_SECRET: randomBytes(32).toString("hex"),
      PANEL_URL: "http://painel.teste",
      RECORDINGS_PATH: recDir,
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
  await ownerQuery(
    db,
    `UPDATE cameras SET motion_source = 'camera', motion_smtp_user = $2, motion_smtp_hash = $3 WHERE id = $1`,
    [cam1, USER, hashSmtpPassword(USER, PASS)],
  );
  server = createEventsSmtpServer({
    pool,
    log: pino({ level: "silent" }),
    name: "topcam.teste",
    authMaxFailures: 3,
    authBlockS: 60,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  await pool?.end();
  await db?.drop();
  rmSync(recDir, { recursive: true, force: true });
});

const motionRows = (cam: string) =>
  ownerQuery<{ kind: string; hits: number; source: string; started_at: Date; ended_at: Date }>(
    db,
    "SELECT kind, hits, source, started_at, ended_at FROM motion_events WHERE camera_id = $1 ORDER BY id",
    [cam],
  );

describe("receptor de eventos por e-mail (câmeras com detecção própria)", () => {
  beforeEach(async () => {
    await ownerQuery(db, "DELETE FROM motion_events");
  });

  it("e-mail da câmera vira movimento; avisos seguidos viram um só evento", async () => {
    await sendAsCamera("Alarm Event: Motion Detection");
    await sendAsCamera("SMD - Smart Motion Detection (Human)");
    const ev = await motionRows(cam1);
    expect(ev.length).toBe(1);
    expect(ev[0]).toMatchObject({ source: "camera", hits: 2, kind: "human" });
    const cam = await ownerQuery<{ last_motion_at: Date | null }>(
      db,
      "SELECT last_motion_at FROM cameras WHERE id = $1",
      [cam1],
    );
    expect(cam[0]!.last_motion_at).not.toBeNull();
  });

  it("e-mail de teste da câmera aparece nos eventos e não é movimento", async () => {
    await sendAsCamera("Test");
    expect((await motionRows(cam1)).length).toBe(0);
    const ev = await ownerQuery(
      db,
      "SELECT 1 FROM camera_events WHERE camera_id = $1 AND type = 'motion_mail_test'",
      [cam1],
    );
    expect(ev.length).toBe(1);
  });

  it("câmera configurada para detecção pelo servidor: o e-mail é aceito mas ignorado", async () => {
    await ownerQuery(db, "UPDATE cameras SET motion_source = 'server' WHERE id = $1", [cam1]);
    await sendAsCamera("Motion");
    expect((await motionRows(cam1)).length).toBe(0);
    await ownerQuery(db, "UPDATE cameras SET motion_source = 'camera' WHERE id = $1", [cam1]);
  });

  it("senha errada é recusada e, depois de várias, o IP fica bloqueado", async () => {
    await expect(sendAsCamera("Motion", USER, "errada")).rejects.toThrow(/recusad|535|inválid/i);
    await expect(sendAsCamera("Motion", "naoexiste", "x")).rejects.toThrow();
    await expect(sendAsCamera("Motion", USER, "errada2")).rejects.toThrow();
    // Bloqueado: nem a senha certa passa.
    await expect(sendAsCamera("Motion")).rejects.toThrow();
    expect((await motionRows(cam1)).length).toBe(0);
    const blocked = await ownerQuery<{ message: string }>(
      db,
      "SELECT message FROM camera_events WHERE type = 'motion_auth_blocked'",
    );
    expect(blocked.length).toBe(1);
    expect(blocked[0]!.message).not.toContain(PASS);
  });
});

describe("gravação só com movimento", () => {
  const T = Date.now() - 2 * 3600_000; // há 2 h
  const at = (s: number) => new Date(T + s * 1000);
  const segs: Record<string, string> = {};

  beforeAll(async () => {
    await ownerQuery(db, "DELETE FROM motion_events");
    await ownerQuery(
      db,
      `UPDATE cameras SET recording_enabled = true, recording_mode = 'motion', motion_source = 'server',
              retention_policy_id = (SELECT id FROM retention_policies WHERE name = '24 horas' AND tenant_id IS NULL)
        WHERE id = $1`,
      [cam2],
    );
    mkdirSync(join(recDir, "cam", cam2), { recursive: true });
    for (const [i, name] of ["a", "b", "c", "d"].entries()) {
      const rel = `cam/${cam2}/${name}.mp4`;
      writeFileSync(join(recDir, rel), "x");
      const r = await withScope(pool, PLATFORM, (c) =>
        upsertSegmentStart(c, { cameraId: cam2, relPath: rel, startedAt: at(i * 60) }),
      );
      segs[name] = r!.segment.id;
      await withScope(pool, PLATFORM, (c) =>
        markSegmentVerified(c, r!.segment.id, {
          durationMs: 60_000,
          sizeBytes: 1,
          checksum: "x",
          videoCodec: "h264",
          audioCodec: null,
        }),
      );
    }
  });

  it("segmento nasce em espera, com validade de 1 h", async () => {
    const r = await ownerQuery<{ motion_hold: boolean; hours: number }>(
      db,
      "SELECT motion_hold, extract(epoch FROM expires_at - started_at) / 3600 AS hours FROM recording_segments WHERE id = $1",
      [segs.a],
    );
    expect(r[0]).toMatchObject({ motion_hold: true });
    expect(Number(r[0]!.hours)).toBeCloseTo(1);
  });

  it("mantém o que encosta no movimento (10 s antes, 30 s depois) e apaga o resto", async () => {
    // Movimento de 90 s a 100 s: com a folga, 80–130 s → segmentos b (60–120) e c (120–180).
    await withScope(pool, PLATFORM, (c) =>
      recordMotionHit(c, { cameraId: cam2, source: "server", at: at(90), until: at(100) }),
    );
    expect(await withScope(pool, PLATFORM, (c) => keepMotionSegments(c))).toBe(2);
    const st = await ownerQuery<{ id: string; motion_hold: boolean; hours: number }>(
      db,
      `SELECT id::text, motion_hold, extract(epoch FROM expires_at - started_at) / 3600 AS hours
         FROM recording_segments WHERE camera_id = $1 ORDER BY started_at`,
      [cam2],
    );
    expect(st.map((s) => s.motion_hold)).toEqual([true, false, false, true]);
    expect(Number(st[1]!.hours)).toBeCloseTo(24);

    // A espera de 1 h venceu (os segmentos são de 2 h atrás): a retenção apaga a e d.
    const r = await applyRetention(ctx);
    expect(r.deleted).toBe(2);
    expect(existsSync(join(recDir, `cam/${cam2}/a.mp4`))).toBe(false);
    expect(existsSync(join(recDir, `cam/${cam2}/b.mp4`))).toBe(true);
    const del = await ownerQuery<{ deleted_reason: string }>(
      db,
      "SELECT deleted_reason FROM recording_segments WHERE camera_id = $1 AND state = 'deleted'",
      [cam2],
    );
    expect(del.map((d) => d.deleted_reason)).toEqual(["no_motion", "no_motion"]);
  });

  it("trecho apagado por falta de movimento não vira lacuna de sinal", async () => {
    const rel = `cam/${cam2}/e.mp4`;
    writeFileSync(join(recDir, rel), "x");
    const r = await withScope(pool, PLATFORM, (c) =>
      upsertSegmentStart(c, { cameraId: cam2, relPath: rel, startedAt: at(240) }),
    );
    const v = await withScope(pool, PLATFORM, (c) =>
      markSegmentVerified(c, r!.segment.id, {
        durationMs: 60_000,
        sizeBytes: 1,
        checksum: "x",
        videoCodec: "h264",
        audioCodec: null,
      }),
    );
    expect(v!.gaps).toBe(0);
  });

  it("voltar para gravação contínua não apaga o que estava em espera", async () => {
    const { releaseMotionHolds } = await import("@topcam/db");
    const n = await withScope(pool, PLATFORM, (c) => releaseMotionHolds(c, cam2));
    expect(n).toBe(1); // o segmento "e"
    const left = await ownerQuery(
      db,
      "SELECT 1 FROM recording_segments WHERE camera_id = $1 AND motion_hold AND state <> 'deleted'",
      [cam2],
    );
    expect(left.length).toBe(0);
  });
});

describe("alarme", () => {
  const sent: Array<MailMessage> = [];
  const send = async (_s: SmtpSettings, _k: Buffer, m: MailMessage) => {
    sent.push(m);
  };
  let viewerWith = "";

  beforeAll(async () => {
    const role = async (k: string) =>
      (await ownerQuery<{ id: string }>(db, "SELECT id FROM roles WHERE key = $1", [k]))[0]!.id;
    const mk = async (email: string, r: string, status = "active") =>
      (
        await ownerQuery<{ id: string }>(
          db,
          `INSERT INTO users (tenant_id, role_id, name, email, status) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [tenant, await role(r), email, email, status],
        )
      )[0]!.id;
    await mk("gestor@alfa.test", "tenant_admin");
    viewerWith = await mk("porteiro@alfa.test", "viewer");
    await mk("outro@alfa.test", "viewer");
    await mk("desativado@alfa.test", "tenant_admin", "disabled");
    await ownerQuery(
      db,
      "INSERT INTO user_camera_permissions (tenant_id, user_id, camera_id, can_live) VALUES ($1, $2, $3, true)",
      [tenant, viewerWith, cam1],
    );
    await ownerQuery(
      db,
      `UPDATE system_settings SET value = value || $1::jsonb WHERE key = 'integrations.smtp'`,
      [JSON.stringify({ host: "127.0.0.1", port: 25, from_email: "topcam@teste.local" })],
    );
  });

  beforeEach(async () => {
    sent.length = 0;
    await ownerQuery(db, "DELETE FROM alarm_notifications");
    await ownerQuery(db, "DELETE FROM motion_events");
    await ownerQuery(
      db,
      `UPDATE cameras SET motion_source = 'camera', alarm_enabled = true, alarm_schedule = '{"rules": []}',
              alarm_cooldown_s = 300, alarm_email = true, alarm_last_notified_at = NULL WHERE id = $1`,
      [cam1],
    );
  });

  const hit = (at: Date) =>
    withScope(pool, PLATFORM, (c) => recordMotionHit(c, { cameraId: cam1, source: "camera", at }));
  const statuses = async () =>
    (
      await ownerQuery<{ alarm_status: string }>(
        db,
        "SELECT alarm_status FROM motion_events WHERE camera_id = $1 ORDER BY id",
        [cam1],
      )
    ).map((r) => r.alarm_status);

  it("avisa o administrador do cliente e quem tem acesso à câmera", async () => {
    await hit(new Date());
    const r = await processAlarms(ctx, { send });
    expect(r).toMatchObject({ notified: 1, emails: 2, failed: 0 });
    expect(sent.map((m) => m.to[0]).sort()).toEqual(["gestor@alfa.test", "porteiro@alfa.test"]);
    expect(sent[0]!.subject).toBe("[TopCam] Movimento detectado: Entrada Principal (Matriz)");
    expect(sent[0]!.text).toContain(`http://painel.teste/gravacoes?camera=${cam1}&t=`);
    expect(await statuses()).toEqual(["sent"]);
    const n = await ownerQuery(db, "SELECT 1 FROM alarm_notifications WHERE status = 'sent'");
    expect(n.length).toBe(2);
  });

  it("intervalo mínimo: o segundo movimento logo depois não notifica", async () => {
    const now = Date.now();
    await hit(new Date(now - 200_000));
    await processAlarms(ctx, { send, now });
    await hit(new Date(now - 60_000)); // 140 s depois do primeiro (fora da junção de 60 s)
    await processAlarms(ctx, { send, now });
    expect(await statuses()).toEqual(["sent", "suppressed_cooldown"]);
    expect(sent.length).toBe(2); // só o primeiro (2 destinatários)
  });

  it("fora do horário não notifica; alarme desligado também não", async () => {
    // Horário que nunca vale: domingo 03:00–03:01, com o movimento agora (quinta… qualquer dia)
    const now = new Date();
    const { localWeekMinute } = await import("@topcam/shared");
    const { dow } = localWeekMinute(now);
    const other = (dow + 3) % 7;
    await ownerQuery(db, `UPDATE cameras SET alarm_schedule = $2 WHERE id = $1`, [
      cam1,
      JSON.stringify({ rules: [{ days: [other], from: "03:00", to: "03:01" }] }),
    ]);
    await hit(now);
    await processAlarms(ctx, { send });
    await ownerQuery(db, "UPDATE cameras SET alarm_enabled = false WHERE id = $1", [cam1]);
    await hit(new Date(now.getTime() + 120_000));
    await processAlarms(ctx, { send, now: now.getTime() + 120_000 });
    expect(await statuses()).toEqual(["suppressed_schedule", "disabled"]);
    expect(sent.length).toBe(0);
  });

  it("movimento antigo (worker parado) não notifica", async () => {
    await hit(new Date(Date.now() - 20 * 60_000));
    await processAlarms(ctx, { send });
    expect(await statuses()).toEqual(["expired"]);
  });

  it("sem e-mail configurado: registra a falha", async () => {
    await ownerQuery(
      db,
      `UPDATE system_settings SET value = value || '{"host": ""}'::jsonb WHERE key = 'integrations.smtp'`,
    );
    await hit(new Date());
    const r = await processAlarms(ctx, { send });
    expect(r.notified).toBe(1);
    expect(await statuses()).toEqual(["failed"]);
    const f = await ownerQuery<{ error: string }>(db, "SELECT error FROM alarm_notifications");
    expect(f[0]!.error).toMatch(/não configurado/);
    await ownerQuery(
      db,
      `UPDATE system_settings SET value = value || '{"host": "127.0.0.1"}'::jsonb WHERE key = 'integrations.smtp'`,
    );
  });
});

describe("detector do servidor (ffmpeg de verdade)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "topcam-det-"));
    const mk = (name: string, vf: string) =>
      execFileSync("ffmpeg", [
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        vf,
        "-t",
        "8",
        "-g",
        "10",
        "-pix_fmt",
        "yuv420p",
        "-c:v",
        "libx264",
        join(dir, name),
      ]);
    // Quadrado branco atravessando a imagem (overlay recalcula a posição a cada quadro).
    mk(
      "mov.mp4",
      "color=gray:s=640x360:r=10[a];color=white:s=80x80:r=10[b];[a][b]overlay=x='mod(t*90,560)':y=100",
    );
    mk("still.mp4", "color=gray:s=640x360:r=10,drawbox=x=100:y=100:w=80:h=80:color=white:t=fill");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const run = (file: string) =>
    new Promise<{ hits: number; code: number | null }>((resolve) => {
      let hits = 0;
      const d = new CameraDetector("x", join(dir, file), 5, {
        onMotion: () => hits++,
        onExit: (code) => resolve({ hits, code }),
      });
      d.start();
    });

  it("vídeo com objeto em movimento gera avisos", async () => {
    const r = await run("mov.mp4");
    expect(r.code).toBe(0);
    expect(r.hits).toBeGreaterThanOrEqual(4);
  });

  it("vídeo parado não gera aviso", async () => {
    const r = await run("still.mp4");
    expect(r.code).toBe(0);
    expect(r.hits).toBe(0);
  });
});
