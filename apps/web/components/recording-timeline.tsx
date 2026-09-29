"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { fmtClock, fmtDuration, zonedToMs } from "@/lib/format";
import type { Span } from "./recording-player";

/** Linha do tempo do dia: trechos gravados, lacunas de sinal e cursor (clique para ir). */

export interface Gap {
  from: string;
  to: string;
  seconds: number;
}

const ZOOMS = [
  { h: 24, label: "24 h", step: 3 },
  { h: 6, label: "6 h", step: 1 },
  { h: 1, label: "1 h", step: 1 / 6 },
] as const;

export function RecordingTimeline({
  day,
  spans,
  gaps,
  cursor,
  onSeek,
}: {
  day: string; // AAAA-MM-DD no fuso do painel
  spans: Span[];
  gaps: Gap[];
  cursor: number | null;
  onSeek: (ms: number) => void;
}) {
  const [zoom, setZoom] = useState(0);
  const [hover, setHover] = useState<{ x: number; ms: number } | null>(null);
  const [offset, setOffset] = useState<number | null>(null);
  const dayStart = useMemo(() => zonedToMs(`${day}T00:00:00`), [day]);
  const dayEnd = useMemo(() => {
    const next = new Date(`${day}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return zonedToMs(`${next.toISOString().slice(0, 10)}T00:00:00`);
  }, [day]);

  const z = ZOOMS[zoom]!;
  const len = Math.min(z.h * 3600_000, dayEnd - dayStart);
  const center = offset ?? cursor ?? spans.at(-1)?.to ?? dayStart + len / 2;
  const winStart = Math.min(Math.max(dayStart, center - len / 2), dayEnd - len);
  const winEnd = winStart + len;
  const pct = (ms: number) => ((Math.min(Math.max(ms, winStart), winEnd) - winStart) / len) * 100;

  const ticks: number[] = [];
  const stepMs = z.step * 3600_000;
  for (let t = dayStart; t <= dayEnd; t += stepMs) if (t >= winStart && t <= winEnd) ticks.push(t);

  const total = spans.reduce((a, s) => a + (s.to - s.from), 0) / 1000;
  const gapTotal = gaps.reduce((a, g) => a + g.seconds, 0);

  function msAt(e: React.MouseEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - r.left, 0), r.width);
    return { x, ms: winStart + (x / r.width) * len };
  }

  function pan(dir: number) {
    setOffset(Math.min(Math.max(winStart + len / 2 + dir * len * 0.75, dayStart), dayEnd));
  }

  return (
    <div className="card p-3" data-testid="timeline">
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-4 rounded-sm bg-brand-500" /> Gravado ({fmtDuration(total)})
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-4 rounded-sm bg-red-400" /> Lacuna de sinal ({gaps.length}
          {gaps.length ? `, ${fmtDuration(gapTotal)}` : ""})
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-4 rounded-sm bg-slate-200" /> Sem gravação
        </span>
        <div className="ml-auto flex items-center gap-1">
          {zoom > 0 && (
            <>
              <button className="icon-btn h-7 w-7" onClick={() => pan(-1)} aria-label="Anterior">
                <ChevronLeft size={14} />
              </button>
              <button className="icon-btn h-7 w-7" onClick={() => pan(1)} aria-label="Seguinte">
                <ChevronRight size={14} />
              </button>
            </>
          )}
          <div
            className="flex overflow-hidden rounded-md border border-line"
            role="group"
            aria-label="Zoom"
          >
            {ZOOMS.map((o, i) => (
              <button
                key={o.h}
                className={`px-2 py-1 text-xs ${zoom === i ? "bg-brand-600 text-white" : "bg-white hover:bg-slate-50"}`}
                onClick={() => {
                  setZoom(i);
                  setOffset(null);
                }}
                aria-pressed={zoom === i}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div
        className="relative h-10 cursor-pointer select-none overflow-hidden rounded bg-slate-200"
        onClick={(e) => onSeek(msAt(e).ms)}
        onMouseMove={(e) => setHover(msAt(e))}
        onMouseLeave={() => setHover(null)}
        role="slider"
        aria-label="Linha do tempo"
        aria-valuemin={winStart}
        aria-valuemax={winEnd}
        aria-valuenow={cursor ?? winStart}
        aria-valuetext={cursor ? fmtClock(cursor) : "—"}
        tabIndex={0}
        onKeyDown={(e) => {
          if (cursor === null) return;
          if (e.key === "ArrowLeft") onSeek(cursor - 60_000);
          if (e.key === "ArrowRight") onSeek(cursor + 60_000);
        }}
      >
        {spans
          .filter((s) => s.to > winStart && s.from < winEnd)
          .map((s) => (
            <div
              key={s.from}
              className="absolute inset-y-0 bg-brand-500"
              style={{
                left: `${pct(s.from)}%`,
                width: `${Math.max(pct(s.to) - pct(s.from), 0.15)}%`,
              }}
              data-testid="timeline-span"
            />
          ))}
        {gaps
          .map((g) => ({ from: Date.parse(g.from), to: Date.parse(g.to), s: g.seconds }))
          .filter((g) => g.to > winStart && g.from < winEnd)
          .map((g) => (
            <div
              key={g.from}
              className="absolute inset-y-0 bg-red-400"
              style={{
                left: `${pct(g.from)}%`,
                width: `${Math.max(pct(g.to) - pct(g.from), 0.3)}%`,
              }}
              title={`Lacuna de ${fmtDuration(g.s)}: ${fmtClock(g.from)} – ${fmtClock(g.to)}`}
              data-testid="timeline-gap"
            />
          ))}
        {cursor !== null && cursor >= winStart && cursor <= winEnd && (
          <div
            className="absolute inset-y-0 w-0.5 bg-slate-900"
            style={{ left: `${pct(cursor)}%` }}
            data-testid="timeline-cursor"
          >
            <span className="absolute -left-1 -top-0.5 h-2 w-2.5 rounded-sm bg-slate-900" />
          </div>
        )}
        {hover && (
          <div
            className="pointer-events-none absolute top-0 -translate-x-1/2 rounded bg-slate-900 px-1.5 py-0.5 font-mono text-[10px] text-white"
            style={{ left: hover.x }}
          >
            {fmtClock(hover.ms)}
          </div>
        )}
      </div>
      <div className="relative mt-1 h-4 text-[10px] text-muted">
        {ticks.map((t) => (
          <span key={t} className="absolute -translate-x-1/2" style={{ left: `${pct(t)}%` }}>
            {t === dayEnd ? "24:00" : fmtClock(t).slice(0, 5)}
          </span>
        ))}
      </div>
    </div>
  );
}
