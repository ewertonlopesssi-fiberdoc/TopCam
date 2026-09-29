"use client";

import { useMemo, useRef, useState } from "react";
import { fmtClock } from "@/lib/format";

/**
 * Gráfico de linha de uma série (uso do disco, latência): linha de 2 px com área a
 * ~10%, grade discreta, linhas de referência (limites) e cruz + dica ao passar o
 * mouse. Uma série só, então sem legenda: o título do cartão diz o que é.
 * Tabela equivalente para leitores de tela.
 */

export interface Point {
  t: number; // ms
  v: number | null;
}

export function LineChart({
  points,
  yMax,
  format,
  thresholds = [],
  height = 140,
  label,
  testId,
}: {
  points: Point[];
  yMax: number;
  format: (v: number) => string;
  thresholds?: Array<{ v: number; label: string }>;
  height?: number;
  label: string;
  testId?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 600;
  const H = height;
  const pad = { l: 44, r: 8, t: 8, b: 20 };
  const valid = points.filter((p) => p.v !== null) as Array<{ t: number; v: number }>;
  const t0 = valid[0]?.t ?? Date.now() - 86400_000;
  const t1 = Math.max(valid.at(-1)?.t ?? Date.now(), t0 + 60_000);
  const x = (t: number) => pad.l + ((t - t0) / (t1 - t0)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - Math.min(v, yMax) / yMax) * (H - pad.t - pad.b);
  const ticks = [0, yMax / 2, yMax];

  const path = useMemo(() => {
    let d = "";
    let open = false;
    for (const p of points) {
      if (p.v === null) {
        open = false;
        continue;
      }
      d += `${open ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`;
      open = true;
    }
    return d;
  }, [points, yMax, t0, t1]);
  const area = valid.length
    ? `M${x(valid[0]!.t)},${y(0)}` +
      valid.map((p) => `L${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("") +
      `L${x(valid.at(-1)!.t)},${y(0)}Z`
    : "";

  function onMove(e: React.MouseEvent) {
    const r = box.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let best: number | null = null;
    let dist = Infinity;
    valid.forEach((p, i) => {
      const d = Math.abs(x(p.t) - px);
      if (d < dist) {
        dist = d;
        best = i;
      }
    });
    setHover(best);
  }
  const hp = hover !== null ? valid[hover] : null;

  if (!valid.length)
    return (
      <div className="flex h-24 items-center justify-center text-xs text-muted">
        Sem amostras ainda (uma a cada 5 min).
      </div>
    );

  return (
    <div ref={box} className="relative" data-testid={testId}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={label}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="#e5e7eb" strokeWidth={1} />
            <text x={pad.l - 6} y={y(v) + 3} textAnchor="end" fontSize={10} fill="#64748b">
              {format(v)}
            </text>
          </g>
        ))}
        {thresholds
          .filter((th) => th.v <= yMax)
          .map((th) => (
            <g key={th.label}>
              <line
                x1={pad.l}
                x2={W - pad.r}
                y1={y(th.v)}
                y2={y(th.v)}
                stroke="#94a3b8"
                strokeWidth={1}
              />
              <text x={W - pad.r - 2} y={y(th.v) - 3} textAnchor="end" fontSize={9} fill="#64748b">
                {th.label}
              </text>
            </g>
          ))}
        <path d={area} fill="#2f74f5" fillOpacity={0.1} />
        <path
          d={path}
          fill="none"
          stroke="#2f74f5"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {[t0, (t0 + t1) / 2, t1].map((t, i) => (
          <text
            key={i}
            x={x(t)}
            y={H - 5}
            textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}
            fontSize={10}
            fill="#64748b"
          >
            {fmtClock(t).slice(0, 5)}
          </text>
        ))}
        {hp && (
          <g>
            <line
              x1={x(hp.t)}
              x2={x(hp.t)}
              y1={pad.t}
              y2={H - pad.b}
              stroke="#94a3b8"
              strokeWidth={1}
            />
            <circle cx={x(hp.t)} cy={y(hp.v)} r={4} fill="#2f74f5" stroke="#fff" strokeWidth={2} />
          </g>
        )}
      </svg>
      {hp && (
        <div
          className="pointer-events-none absolute top-0 -translate-x-1/2 rounded bg-slate-900 px-2 py-1 text-[11px] whitespace-nowrap text-white"
          style={{ left: `${(x(hp.t) / W) * 100}%` }}
        >
          {fmtClock(hp.t).slice(0, 5)} · {format(hp.v)}
        </div>
      )}
      <table className="sr-only">
        <caption>{label}</caption>
        <tbody>
          {valid.map((p) => (
            <tr key={p.t}>
              <td>{fmtClock(p.t)}</td>
              <td>{format(p.v)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
