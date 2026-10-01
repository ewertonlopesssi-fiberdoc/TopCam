import {
  PLATFORM,
  findCameraBySmtpLogin,
  insertCameraEvent,
  recordMotionHit,
  withScope,
  type Pool,
} from "@topcam/db";
import { classifyMotionMail, isTestMail } from "@topcam/shared";
import { simpleParser } from "mailparser";
import type { Logger } from "pino";
import { SMTPServer, type SMTPServerOptions, type SMTPServerSession } from "smtp-server";

/**
 * Receptor de eventos por e-mail (SMTP) — câmeras com detecção própria (ex.: Intelbras VIP)
 * mandam um e-mail a cada detecção. Funciona atrás de NAT/CGNAT: quem inicia é a câmera,
 * como no RTMP.
 *
 *  - Cada câmera tem usuário e senha exclusivos (gerados no painel); é pelo usuário que a
 *    câmera é reconhecida. Remetente e destinatário não importam.
 *  - STARTTLS oferecido (certificado do painel quando houver); sem criptografia também é
 *    aceito, porque muitas câmeras não suportam — a senha só serve para avisar movimento.
 *  - Quem erra a senha muitas vezes tem o IP bloqueado por um tempo.
 *  - O conteúdo do e-mail (inclusive a foto) não é guardado: só o horário e o tipo.
 */

export interface EventsSmtpOptions {
  pool: Pool;
  log: Logger;
  /** Nome anunciado (EHLO). */
  name: string;
  /** Certificado/chave PEM (STARTTLS). Sem eles, o smtp-server usa um próprio. */
  tls?: { key: Buffer; cert: Buffer } | null;
  /** Para trocar o certificado sem reiniciar (renovação). */
  sniCallback?: SMTPServerOptions["SNICallback"];
  maxSizeBytes?: number;
  /** Erros de senha por IP antes do bloqueio, na janela, e duração do bloqueio. */
  authMaxFailures?: number;
  authWindowS?: number;
  authBlockS?: number;
  /** Avisos por câmera por hora (excesso é recusado temporariamente). */
  perCameraPerHour?: number;
  now?: () => number;
}

interface Strikes {
  n: number;
  first: number;
  blockedUntil: number;
}

interface CameraSession {
  id: string;
  tenant_id: string;
  code: string;
  motion_source: string;
}

export function createEventsSmtpServer(o: EventsSmtpOptions): SMTPServer {
  const now = o.now ?? Date.now;
  const maxFail = o.authMaxFailures ?? 10;
  const windowMs = (o.authWindowS ?? 600) * 1000;
  const blockMs = (o.authBlockS ?? 1800) * 1000;
  const perHour = o.perCameraPerHour ?? 720;
  const strikes = new Map<string, Strikes>();
  const hourly = new Map<string, { hour: number; n: number }>();

  function blocked(ip: string): boolean {
    const s = strikes.get(ip);
    return Boolean(s && s.blockedUntil > now());
  }

  async function fail(ip: string, user: string) {
    const t = now();
    let s = strikes.get(ip);
    if (!s || t - s.first > windowMs) s = { n: 0, first: t, blockedUntil: 0 };
    s.n++;
    if (s.n >= maxFail && s.blockedUntil <= t) {
      s.blockedUntil = t + blockMs;
      o.log.warn({ ip, failures: s.n }, "eventos: IP bloqueado por senha errada");
      await withScope(o.pool, PLATFORM, (c) =>
        insertCameraEvent(c, {
          tenantId: null,
          cameraId: null,
          type: "motion_auth_blocked",
          severity: "warning",
          message: `IP ${ip} bloqueado por ${Math.round(blockMs / 60000)} min: ${s!.n} senhas erradas no receptor de eventos`,
          data: { failures: s!.n, last_user: user.slice(0, 40) },
          sourceIp: ip,
        }),
      ).catch(() => undefined);
    }
    strikes.set(ip, s);
    // Limpeza das entradas antigas.
    if (strikes.size > 5000)
      for (const [k, v] of strikes)
        if (v.blockedUntil < t && t - v.first > windowMs) strikes.delete(k);
  }

  function overQuota(cameraId: string): boolean {
    const hour = Math.floor(now() / 3_600_000);
    const h = hourly.get(cameraId);
    if (!h || h.hour !== hour) {
      hourly.set(cameraId, { hour, n: 1 });
      return false;
    }
    h.n++;
    return h.n > perHour;
  }

  const options: SMTPServerOptions = {
    name: o.name,
    banner: "TopCam - receptor de eventos",
    authMethods: ["PLAIN", "LOGIN"],
    authOptional: false,
    allowInsecureAuth: true,
    size: o.maxSizeBytes ?? 5 * 1024 * 1024,
    maxClients: 200,
    socketTimeout: 60_000,
    closeTimeout: 5_000,
    disabledCommands: [],
    logger: false,
    ...(o.tls ? { key: o.tls.key, cert: o.tls.cert } : {}),
    ...(o.sniCallback ? { SNICallback: o.sniCallback } : {}),

    onConnect(session, cb) {
      if (blocked(session.remoteAddress)) {
        const err = new Error("Acesso bloqueado temporariamente") as Error & {
          responseCode: number;
        };
        err.responseCode = 421;
        return cb(err);
      }
      cb();
    },

    onAuth(auth, session, cb) {
      const ip = session.remoteAddress;
      const user = String(auth.username ?? "").trim();
      const pass = String(auth.password ?? "");
      if (blocked(ip)) return cb(new Error("Acesso bloqueado temporariamente"));
      if (!user || !pass || user.length > 64 || pass.length > 128) {
        void fail(ip, user);
        return cb(new Error("Usuário ou senha inválidos"));
      }
      withScope(o.pool, PLATFORM, (c) => findCameraBySmtpLogin(c, user, pass))
        .then(async (cam) => {
          if (!cam) {
            await fail(ip, user);
            return cb(new Error("Usuário ou senha inválidos"));
          }
          strikes.delete(ip);
          cb(null, { user: cam });
        })
        .catch((err: Error) => {
          o.log.error({ err: err.message }, "eventos: falha ao conferir credencial");
          const e = new Error("Falha temporária") as Error & { responseCode: number };
          e.responseCode = 454;
          cb(e);
        });
    },

    onMailFrom(_addr, session, cb) {
      if (!session.user) return cb(new Error("Autenticação necessária"));
      cb();
    },
    onRcptTo(_addr, _session, cb) {
      cb();
    },

    onData(stream, session: SMTPServerSession, cb) {
      const cam = session.user as unknown as CameraSession | undefined;
      const at = new Date(now());
      simpleParser(stream, { skipImageLinks: true, skipHtmlToText: false })
        .then(async (mail) => {
          if (stream.sizeExceeded) {
            const e = new Error("Mensagem grande demais") as Error & { responseCode: number };
            e.responseCode = 552;
            return cb(e);
          }
          if (!cam) return cb(new Error("Autenticação necessária"));
          if (overQuota(cam.id)) {
            const e = new Error("Avisos demais nesta hora") as Error & { responseCode: number };
            e.responseCode = 452;
            return cb(e);
          }
          const subject = (mail.subject ?? "").slice(0, 300);
          const text = (mail.text ?? "").slice(0, 4000);
          if (isTestMail(subject)) {
            await withScope(o.pool, PLATFORM, (c) =>
              insertCameraEvent(c, {
                tenantId: cam.tenant_id,
                cameraId: cam.id,
                type: "motion_mail_test",
                message: `E-mail de teste de ${cam.code} recebido pelo receptor de eventos`,
                data: { subject },
                sourceIp: session.remoteAddress,
              }),
            );
            return cb();
          }
          const kind = classifyMotionMail(subject, text);
          const r = await withScope(o.pool, PLATFORM, (c) =>
            recordMotionHit(c, {
              cameraId: cam.id,
              source: "camera",
              kind,
              at,
              data: { subject },
            }),
          );
          if (!r)
            o.log.info(
              { camera: cam.code },
              "eventos: aviso recebido, mas a câmera não usa detecção pela câmera",
            );
          else o.log.debug({ camera: cam.code, kind, event: r.event.id }, "eventos: movimento");
          cb();
        })
        .catch((err: Error) => {
          o.log.warn({ err: err.message }, "eventos: mensagem ilegível");
          stream.resume();
          cb(new Error("Mensagem ilegível"));
        });
    },
  };
  return new SMTPServer(options);
}
