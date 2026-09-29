"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

/** Calendário do mês (pt-BR) com os dias que têm gravação destacados. */

const WEEK = ["D", "S", "T", "Q", "Q", "S", "S"];
const MONTHS = [
  "Janeiro",
  "Fevereiro",
  "Março",
  "Abril",
  "Maio",
  "Junho",
  "Julho",
  "Agosto",
  "Setembro",
  "Outubro",
  "Novembro",
  "Dezembro",
];

export function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

export function MonthCalendar({
  month,
  onMonth,
  selected,
  today,
  days,
  onPick,
}: {
  month: string; // AAAA-MM
  onMonth: (m: string) => void;
  selected: string;
  today: string;
  days: Record<string, number>; // dia → segundos gravados
  onPick: (day: string) => void;
}) {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells: Array<string | null> = [
    ...Array<null>(first).fill(null),
    ...Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`),
  ];
  const canNext = month < today.slice(0, 7);

  return (
    <div className="card p-3" data-testid="calendar">
      <div className="mb-2 flex items-center justify-between">
        <button
          className="icon-btn h-7 w-7"
          onClick={() => onMonth(shiftMonth(month, -1))}
          aria-label="Mês anterior"
        >
          <ChevronLeft size={14} />
        </button>
        <span className="text-sm font-semibold">
          {MONTHS[m - 1]} {y}
        </span>
        <button
          className="icon-btn h-7 w-7"
          onClick={() => onMonth(shiftMonth(month, 1))}
          disabled={!canNext}
          aria-label="Próximo mês"
        >
          <ChevronRight size={14} />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-0.5 text-center text-[11px]">
        {WEEK.map((w, i) => (
          <span key={i} className="py-1 font-medium text-muted">
            {w}
          </span>
        ))}
        {cells.map((d, i) => {
          if (!d) return <span key={`e${i}`} />;
          const has = (days[d] ?? 0) > 0;
          const isSel = d === selected;
          const future = d > today;
          return (
            <button
              key={d}
              disabled={future}
              onClick={() => onPick(d)}
              className={`relative h-8 rounded text-xs transition ${
                isSel
                  ? "bg-brand-600 font-semibold text-white"
                  : has
                    ? "bg-brand-50 font-semibold text-brand-700 hover:bg-brand-100"
                    : "text-slate-500 hover:bg-slate-50"
              } ${future ? "opacity-30" : ""} ${d === today && !isSel ? "ring-1 ring-brand-500" : ""}`}
              aria-pressed={isSel}
              aria-label={`${d.split("-").reverse().join("/")}${has ? ", com gravação" : ""}`}
              data-has-recording={has || undefined}
            >
              {Number(d.slice(8))}
              {has && !isSel && (
                <span className="absolute bottom-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-brand-500" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
