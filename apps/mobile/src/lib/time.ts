/**
 * Datas no horário de Brasília (UTC−3, sem horário de verão desde 2019), como no painel.
 * Sem dependência de React Native.
 */
export const BR_OFFSET_MS = 3 * 3600_000;

/** AAAA-MM-DD do dia (Brasília) que contém o instante. */
export function dayOf(ms: number): string {
  return new Date(ms - BR_OFFSET_MS).toISOString().slice(0, 10);
}

/** Início do dia (Brasília) em ms UTC. */
export function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) + BR_OFFSET_MS;
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

export function monthDays(month: string): string[] {
  const out: string[] = [];
  for (let d = `${month}-01`; d.startsWith(month); d = addDays(d, 1)) out.push(d);
  return out;
}

/** HH:MM:SS (Brasília). */
export function clock(ms: number, seconds = true): string {
  return new Date(ms - BR_OFFSET_MS).toISOString().slice(11, seconds ? 19 : 16);
}

/** "hoje 14:32", "ontem 09:10" ou "05/10 18:00". */
export function whenLabel(ms: number, now = Date.now()): string {
  const d = dayOf(ms);
  const hm = clock(ms, false);
  if (d === dayOf(now)) return `hoje ${hm}`;
  if (d === addDays(dayOf(now), -1)) return `ontem ${hm}`;
  return `${d.slice(8, 10)}/${d.slice(5, 7)} ${hm}`;
}

const MONTHS = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];
export function monthLabel(month: string): string {
  return `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

/** Dia da semana (0 = domingo) de um AAAA-MM-DD. */
export function weekday(day: string): number {
  return new Date(`${day}T12:00:00Z`).getUTCDay();
}

export interface Span {
  from: number;
  to: number;
}

/** Junta segmentos encostados (até 3 s) em blocos contínuos, como no painel. */
export function toSpans(segments: { startedAt: string; endedAt: string }[], gapMs = 3000): Span[] {
  const out: Span[] = [];
  for (const s of segments) {
    const from = Date.parse(s.startedAt);
    const to = Date.parse(s.endedAt);
    const last = out.at(-1);
    if (last && from - last.to <= gapMs) last.to = Math.max(last.to, to);
    else out.push({ from, to });
  }
  return out;
}

/** Bloco que contém o instante ou, numa lacuna, o próximo bloco. */
export function spanAt(spans: Span[], at: number): Span | null {
  return (
    spans.find((s) => at >= s.from && at < s.to - 500) ?? spans.find((s) => s.from > at) ?? null
  );
}

/** Trecho de reprodução a partir de `at`: até o fim do bloco, no máximo `maxS` segundos. */
export function chunkFrom(
  spans: Span[],
  at: number,
  maxS = 900,
): { start: number; end: number } | null {
  const span = spanAt(spans, at);
  if (!span) return null;
  const start = Math.max(at, span.from + 5);
  return { start, end: Math.min(span.to, start + maxS * 1000) };
}

/** Segundos desde a meia-noite (Brasília) do instante. */
export function secOfDay(ms: number): number {
  const d = (ms - BR_OFFSET_MS) % 86_400_000;
  return Math.floor((d < 0 ? d + 86_400_000 : d) / 1000);
}

/** Instante (ms UTC) do dia (Brasília) mais `sec` segundos. */
export function atDaySec(day: string, sec: number): number {
  return dayStart(day) + sec * 1000;
}

export interface RangeCheck {
  /** Impede o download. */
  error: string | null;
  /** Fim usado (cortado para "agora" se estiver no futuro). */
  end: number;
  /** Fim foi cortado para o último segundo gravado. */
  clamped: boolean;
  /** Intervalos sem gravação dentro do trecho (o vídeo pula esses intervalos). */
  missing: Span[];
}

/**
 * Confere um trecho para baixar: fim depois do início, no máximo `maxS` (limite do servidor),
 * nada no futuro e alguma gravação no meio. Lacunas menores que 3 s são ignoradas.
 */
export function checkRange(
  spans: Span[],
  start: number,
  end: number,
  now = Date.now(),
  maxS = 3600,
): RangeCheck {
  const limit = now - 5000;
  const clamped = end > limit;
  const e = Math.min(end, limit);
  const out: RangeCheck = { error: null, end: e, clamped, missing: [] };
  if (start >= limit) return { ...out, error: "O início ainda não foi gravado." };
  if (end <= start) return { ...out, error: "O fim precisa ser depois do início." };
  if ((e - start) / 1000 > maxS)
    return {
      ...out,
      error: `O trecho pode ter no máximo ${Math.round(maxS / 60)} minutos. Baixe em partes.`,
    };
  let at = start;
  let covered = 0;
  for (const s of spans) {
    if (s.to <= start || s.from >= e) continue;
    const from = Math.max(s.from, start);
    const to = Math.min(s.to, e);
    if (from - at >= 3000) out.missing.push({ from: at, to: from });
    covered += to - from;
    at = Math.max(at, to);
  }
  // O final recente ainda está sendo gravado (o segmento só entra depois de fechado): não avisa.
  if (e - at >= 3000 && at < now - 180_000) out.missing.push({ from: at, to: e });
  if (covered <= 0)
    return {
      ...out,
      missing: [],
      error: `Não há gravação entre ${clock(start)} e ${clock(e)}.`,
    };
  return out;
}
