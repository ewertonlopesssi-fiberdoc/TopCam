import { readFile } from "node:fs/promises";
import {
  PLATFORM,
  insertCameraEvent,
  raiseAlert,
  resolveAlert,
  withScope,
  type AlertSeverity,
} from "@topcam/db";
import type { WorkerContext } from "../context.js";
import { measureFs, type FsInfo } from "./storage.js";

/**
 * Métricas do servidor (tela Servidores, Fase 6), lidas de dentro do contêiner do
 * worker — o /proc e o disco "/" são os da VM:
 *  - CPU (%), carga, memória, tempo ligado;
 *  - pressão de IO e de CPU (PSI do kernel): % do tempo com processos parados
 *    esperando disco — o sintoma das travadas do armazenamento;
 *  - disco do sistema (banco, Docker, logs): alerta em 85% e 95% (sem ação automática);
 *  - serviços: API, banco, Redis e servidor de mídia (pelo /ready da API).
 */

export interface HostState {
  lastCpu: { idle: number; total: number } | null;
}
export const newHostState = (): HostState => ({ lastCpu: null });

export interface HostMetrics {
  at: string;
  cpu_pct: number | null;
  cpus: number;
  load1: number;
  load5: number;
  mem_total: number;
  mem_available: number;
  uptime_s: number;
  io_pressure: { some10: number; full10: number; some300: number; full300: number } | null;
  cpu_pressure: { some10: number; some300: number } | null;
  system_disk: FsInfo & { pct: number };
  services: Record<string, "ok" | "fail">;
}

async function readText(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export function parsePressure(text: string) {
  const out: Record<string, Record<string, number>> = {};
  for (const line of text.trim().split("\n")) {
    const [kind, ...pairs] = line.trim().split(/\s+/);
    out[kind!] = Object.fromEntries(
      pairs.map((p) => {
        const [k, v] = p.split("=");
        return [k!, Number(v)];
      }),
    );
  }
  return out;
}

export async function collectHostMetrics(
  ctx: WorkerContext,
  state: HostState,
  deps: {
    read?: typeof readText;
    measure?: typeof measureFs;
    fetchReady?: () => Promise<unknown>;
  } = {},
): Promise<HostMetrics> {
  const read = deps.read ?? readText;
  const measure = deps.measure ?? measureFs;

  const stat = (await read("/proc/stat")).split("\n")[0]!.trim().split(/\s+/).slice(1).map(Number);
  const idle = (stat[3] ?? 0) + (stat[4] ?? 0);
  const total = stat.reduce((a, b) => a + b, 0);
  let cpuPct: number | null = null;
  if (state.lastCpu && total > state.lastCpu.total)
    cpuPct =
      Math.round((1 - (idle - state.lastCpu.idle) / (total - state.lastCpu.total)) * 1000) / 10;
  state.lastCpu = { idle, total };
  const cpus = (await read("/proc/stat")).split("\n").filter((l) => /^cpu\d+ /.test(l)).length;

  const [load1, load5] = (await read("/proc/loadavg")).split(/\s+/).map(Number);
  const mem = Object.fromEntries(
    (await read("/proc/meminfo"))
      .split("\n")
      .map((l) => l.match(/^(\w+):\s+(\d+)/))
      .filter(Boolean)
      .map((m) => [m![1], Number(m![2]) * 1024]),
  ) as Record<string, number>;
  const uptime = Number((await read("/proc/uptime")).split(/\s+/)[0]);

  let ioPressure: HostMetrics["io_pressure"] = null;
  let cpuPressure: HostMetrics["cpu_pressure"] = null;
  try {
    const io = parsePressure(await read("/proc/pressure/io"));
    ioPressure = {
      some10: io.some?.avg10 ?? 0,
      full10: io.full?.avg10 ?? 0,
      some300: io.some?.avg300 ?? 0,
      full300: io.full?.avg300 ?? 0,
    };
    const cpu = parsePressure(await read("/proc/pressure/cpu"));
    cpuPressure = { some10: cpu.some?.avg10 ?? 0, some300: cpu.some?.avg300 ?? 0 };
  } catch {
    /* kernel sem PSI */
  }

  const sys = await measure("/");
  const sysPct = sys.total > 0 ? Math.round(((sys.total - sys.free) / sys.total) * 1000) / 10 : 0;

  const services: Record<string, "ok" | "fail"> = { worker: "ok" };
  try {
    const ready = (await (deps.fetchReady
      ? deps.fetchReady()
      : fetch(ctx.env.API_READY_URL, { signal: AbortSignal.timeout(3000) }).then((r) =>
          r.json(),
        ))) as { checks?: Record<string, "ok" | "fail"> };
    services.api = "ok";
    for (const [k, v] of Object.entries(ready.checks ?? {})) services[k] = v;
  } catch {
    services.api = "fail";
  }

  const m: HostMetrics = {
    at: new Date().toISOString(),
    cpu_pct: cpuPct,
    cpus,
    load1: load1 ?? 0,
    load5: load5 ?? 0,
    mem_total: mem.MemTotal ?? 0,
    mem_available: mem.MemAvailable ?? 0,
    uptime_s: Math.round(uptime),
    io_pressure: ioPressure,
    cpu_pressure: cpuPressure,
    system_disk: { ...sys, pct: sysPct },
    services,
  };

  await withScope(ctx.pool, PLATFORM, async (c) => {
    await c.query(
      `UPDATE ingest_nodes SET metrics = coalesce(metrics, '{}'::jsonb) || jsonb_build_object('host', $1::jsonb)
        WHERE name = 'ingest-01'`,
      [JSON.stringify(m)],
    );
    // Disco do sistema: só alerta (banco, Docker e logs; nada é apagado automaticamente).
    const key = "system_disk:ingest-01";
    if (sysPct >= 85) {
      const severity: AlertSeverity = sysPct >= 95 ? "critical" : "error";
      const opened = await raiseAlert(c, {
        dedupKey: key,
        rule: "system_disk",
        severity,
        title: `Disco do sistema em ${sysPct.toFixed(0)}% (banco, Docker e logs)`,
        details: { pct: sysPct, free_bytes: sys.free, total_bytes: sys.total },
      });
      if (opened)
        await insertCameraEvent(c, {
          tenantId: null,
          cameraId: null,
          type: "system_disk",
          severity: "error",
          message: `Disco do sistema em ${sysPct.toFixed(1)}%`,
          data: { pct: sysPct, free_bytes: sys.free },
        });
    } else if (sysPct < 80) await resolveAlert(c, key);
  });
  return m;
}
