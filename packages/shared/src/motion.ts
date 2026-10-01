import { createHash, randomInt } from "node:crypto";

/**
 * Detecção de movimento, gravação só com movimento e alarme — regras comuns à API,
 * ao worker, ao receptor de eventos (SMTP) e ao painel.
 */

export const MOTION_SOURCES = ["off", "camera", "server"] as const;
export type MotionSource = (typeof MOTION_SOURCES)[number];

export const RECORDING_MODES = ["continuous", "motion"] as const;
export type RecordingMode = (typeof RECORDING_MODES)[number];

/** Folga guardada antes e depois de cada movimento (gravação só com movimento). */
export const MOTION_PRE_S = 10;
export const MOTION_POST_S = 30;
/**
 * Avisos que chegam com até este intervalo entre si viram um único movimento
 * (a câmera costuma mandar um e-mail a cada poucos segundos enquanto há movimento).
 */
export const MOTION_MERGE_S = 60;
/** Quanto tempo um segmento sem movimento fica guardado antes de ser apagado. */
export const MOTION_HOLD_MIN = 60;
/** Duração atribuída a um aviso pontual (e-mail) quando não há outro em seguida. */
export const MOTION_POINT_S = 10;

export const ALARM_TZ = "America/Sao_Paulo";

export interface AlarmRule {
  /** Dias da semana em que a faixa começa (0 = domingo … 6 = sábado). */
  days: number[];
  /** "HH:MM". Se from > to, a faixa atravessa a meia-noite. from = to = dia inteiro. */
  from: string;
  to: string;
}
export interface AlarmSchedule {
  rules: AlarmRule[];
}

export const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return h * 60 + m;
}

/** Dia da semana e minuto do dia no fuso informado. */
export function localWeekMinute(at: Date, tz = ALARM_TZ): { dow: number; min: number } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday!);
  return { dow, min: Number(p.hour) * 60 + Number(p.minute) };
}

/**
 * O alarme vale neste instante? Sem regras = sempre. Uma faixa que atravessa a
 * meia-noite pertence ao dia em que começa (ex.: sexta 22:00–06:00 cobre a madrugada
 * de sábado).
 */
export function alarmActiveAt(
  schedule: AlarmSchedule | null | undefined,
  at: Date,
  tz = ALARM_TZ,
): boolean {
  const rules = schedule?.rules ?? [];
  if (rules.length === 0) return true;
  const { dow, min } = localWeekMinute(at, tz);
  const prev = (dow + 6) % 7;
  for (const r of rules) {
    const f = minutes(r.from);
    const t = minutes(r.to);
    if (f === t) {
      if (r.days.includes(dow)) return true;
    } else if (f < t) {
      if (r.days.includes(dow) && min >= f && min < t) return true;
    } else {
      if (r.days.includes(dow) && min >= f) return true;
      if (r.days.includes(prev) && min < t) return true;
    }
  }
  return false;
}

/** Valida e normaliza a agenda vinda do painel (dias únicos e ordenados). */
export function normalizeSchedule(s: AlarmSchedule): AlarmSchedule {
  return {
    rules: s.rules.map((r) => ({
      days: [...new Set(r.days)].filter((d) => d >= 0 && d <= 6).sort(),
      from: r.from,
      to: r.to,
    })),
  };
}

// ------------------------------------------------------------------ credencial SMTP
const LOWER = "abcdefghijklmnopqrstuvwxyz0123456789";
const MIXED = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

/**
 * Usuário e senha exclusivos da câmera para o receptor de eventos. Só letras e números
 * (as telas das câmeras costumam recusar símbolos) e tamanho que cabe nelas (≤ 32).
 */
export function generateSmtpCredential(): { user: string; password: string } {
  let user = "cam";
  for (let i = 0; i < 9; i++) user += LOWER[randomInt(LOWER.length)];
  let password = "";
  for (let i = 0; i < 24; i++) password += MIXED[randomInt(MIXED.length)];
  return { user, password };
}

export function hashSmtpPassword(user: string, password: string): string {
  return createHash("sha256").update(`${user}\0${password}`, "utf8").digest("hex");
}

/**
 * Tipo do aviso a partir do assunto/texto do e-mail da câmera. As câmeras mandam textos
 * diferentes conforme o modelo e o idioma; o que não for reconhecido conta como movimento.
 */
export function classifyMotionMail(subject: string, text: string): "human" | "audio" | "motion" {
  const s = `${subject}\n${text}`.toLowerCase();
  if (/(human|humano|pessoa|person|people|smd|smart ?motion|intelig)/.test(s)) return "human";
  if (/(audio|áudio|sound|som\b)/.test(s)) return "audio";
  return "motion";
}

/** Assunto/linhas de teste das telas de câmera ("Test", "Teste de e-mail"): não é movimento. */
export function isTestMail(subject: string): boolean {
  return /\btest(e|ing)?\b/i.test(subject);
}
