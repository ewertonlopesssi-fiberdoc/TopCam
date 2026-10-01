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
