"use client";

import { Download, Film, List, Lock, Search, X } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CameraTree,
  allCameras,
  type TreeCamera,
  type TreeLocation,
  type TreeTenant,
} from "@/components/camera-tree";
import { MonthCalendar, monthBounds } from "@/components/month-calendar";
import {
  RecordingPlayer,
  type RecordingPlayerHandle,
  type Span,
} from "@/components/recording-player";
import { RecordingTimeline, type Gap } from "@/components/recording-timeline";
import { Empty, ErrorBox, Loading, useToast } from "@/components/ui";
import { ApiError, api, qs, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { TZ, dayOf, fmtClock, fmtDateTime, fmtDuration, msToZoned, zonedToMs } from "@/lib/format";

interface Summary {
  cameraId: string;
  code: string;
  name: string;
  canExport: boolean;
  recordingEnabled: boolean;
  retentionHours: number | null;
  segments: number;
  oldest: string | null;
  newest: string | null;
}
interface Timeline {
  segments: Array<{
    startedAt: string;
    endedAt: string;
    holes?: Array<{ from: number; to: number }>;
  }>;
  gaps: Gap[];
}
interface ExportGrant {
  downloadUrl: string;
  filename: string;
  seconds: number;
  recordedSeconds: number;
}

/**
 * Segmentos a até 1 s um do outro formam um bloco contínuo. É a mesma tolerância do
 * servidor de reprodução, que para de entregar vídeo em qualquer intervalo maior.
 * (As "lacunas" em vermelho, vindas da API, são as maiores que 3 s.)
 */
const JOIN_MS = 1000;

function toSpans(segments: Timeline["segments"]): Span[] {
  const out: Span[] = [];
  for (const s of segments) {
    const start = Date.parse(s.startedAt);
    const end = Date.parse(s.endedAt);
    // Buracos internos (quadros perdidos) dividem o segmento em pedaços.
    let cur = start;
    const pieces: Span[] = [];
    for (const h of s.holes ?? []) {
      const hs = start + h.from * 1000;
      const he = start + h.to * 1000;
      if (hs > cur) pieces.push({ from: cur, to: hs });
      cur = Math.max(cur, he);
    }
    if (cur < end) pieces.push({ from: cur, to: end });
    for (const p of pieces) {
      const last = out.at(-1);
      if (last && p.from - last.to <= JOIN_MS) last.to = Math.max(last.to, p.to);
      else out.push({ ...p });
    }
  }
  return out;
}

function nextDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function Gravacoes() {
  const auth = useAuth();
  const toast = useToast();
  const params = useSearchParams();
  const cameraParam = params.get("camera");

  // ---- clientes, locais e câmeras com gravação
  const [tenants, setTenants] = useState<TreeTenant[]>([]);
  const [tenantId, setTenantId] = useState<string | null>(auth.user?.tenant?.id ?? null);
  const [locations, setLocations] = useState<TreeLocation[]>([]);
  const [cameras, setCameras] = useState<TreeCamera[] | null>(null);
  const [cameraId, setCameraId] = useState<string | null>(cameraParam);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [treeOpen, setTreeOpen] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // ---- câmera escolhida
  const today = dayOf(Date.now());
  const [summary, setSummary] = useState<Summary | null>(null);
  const [denied, setDenied] = useState(false);
  const [day, setDay] = useState(today);
  const [month, setMonth] = useState(today.slice(0, 7));
  const [days, setDays] = useState<Record<string, number>>({});
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [startField, setStartField] = useState("");
  const [endField, setEndField] = useState("");
  const [exporting, setExporting] = useState(false);
  const pendingSeek = useRef<number | null>(null);
  const player = useRef<RecordingPlayerHandle>(null);

  useEffect(() => {
    if (!auth.isPlatform) return;
    api
      .get<Page<TreeTenant>>("/tenants?status=active&pageSize=100")
      .then(async (r) => {
        setTenants(r.items);
        if (cameraParam) {
          const cam = await api.get<TreeCamera>(`/cameras/${cameraParam}`).catch(() => null);
          if (cam) return setTenantId(cam.tenantId);
        }
        setTenantId((cur) => cur ?? r.items[0]?.id ?? null);
      })
      .catch(setError);
  }, [auth.isPlatform, cameraParam]);

  useEffect(() => {
    if (auth.isPlatform && !tenantId) return;
    setCameras(null);
    Promise.all([
      api.get<{ items: TreeLocation[] }>(`/locations${qs({ tenantId: tenantId ?? undefined })}`),
      allCameras(tenantId),
    ])
      .then(([locs, cams]) => {
        const rec = cams.filter((c) => c.enabled && c.recordingEnabled);
        setLocations(locs.items);
        setCameras(rec);
        setCameraId((cur) => (cur && rec.some((c) => c.id === cur) ? cur : (rec[0]?.id ?? null)));
      })
      .catch(setError);
  }, [tenantId, auth.isPlatform]);

  // ---- resumo da câmera (permissão, exportação) e dia inicial
  useEffect(() => {
    setSummary(null);
    setDenied(false);
    setTimeline(null);
    setCursor(null);
    if (!cameraId) return;
    api
      .get<Summary>(`/cameras/${cameraId}/recordings/summary`)
      .then((s) => {
        setSummary(s);
        const d = s.newest ? dayOf(Date.parse(s.newest)) : today;
        setDay(d);
        setMonth(d.slice(0, 7));
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) setDenied(true);
        else setError(err);
      });
  }, [cameraId]);

  // ---- calendário do mês
  useEffect(() => {
    if (!summary) return;
    const { from, to } = monthBounds(month);
    api
      .get<{ items: Array<{ day: string; seconds: number }> }>(
        `/cameras/${summary.cameraId}/recordings/days${qs({ from, to, tz: TZ })}`,
      )
      .then((r) => setDays(Object.fromEntries(r.items.map((i) => [i.day, i.seconds]))))
      .catch(setError);
  }, [summary, month]);

  // ---- linha do tempo do dia (hoje: atualiza a cada minuto)
  const loadDay = useCallback(async () => {
    if (!summary) return;
    const from = zonedToMs(`${day}T00:00:00`);
    const to = Math.min(zonedToMs(`${nextDay(day)}T00:00:00`), Date.now());
    if (to <= from) return setTimeline({ segments: [], gaps: [] });
    try {
      const t = await api.get<Timeline>(
        `/cameras/${summary.cameraId}/recordings${qs({
          from: new Date(from).toISOString(),
          to: new Date(to).toISOString(),
        })}`,
      );
      setTimeline(t);
    } catch (err) {
      setError(err);
    }
  }, [summary, day]);

  useEffect(() => {
    setTimeline(null);
    void loadDay();
    if (day !== today) return;
    const t = setInterval(loadDay, 60_000);
    return () => clearInterval(t);
  }, [loadDay, day, today]);

  const spans = useMemo(() => toSpans(timeline?.segments ?? []), [timeline]);

  // Campos Início/Fim: últimos 5 min gravados do dia (o usuário pode trocar).
  useEffect(() => {
    if (!timeline) return;
    const last = spans.at(-1);
    if (pendingSeek.current !== null) {
      const at = pendingSeek.current;
      pendingSeek.current = null;
      player.current?.seek(at);
      return;
    }
    if (!last) {
      setStartField(`${day}T00:00:00`);
      setEndField(`${day}T00:05:00`);
      return;
    }
    const end = Math.floor(last.to / 1000) * 1000;
    setStartField(msToZoned(Math.max(end - 5 * 60_000, last.from)));
    setEndField(msToZoned(end));
  }, [timeline]);

  const onTime = useCallback((ms: number | null) => setCursor(ms), []);

  function seek(ms: number) {
    const d = dayOf(ms);
    if (d !== day) {
      pendingSeek.current = ms;
      setDay(d);
      setMonth(d.slice(0, 7));
    } else player.current?.seek(ms);
  }

  function buscar() {
    const ms = zonedToMs(startField);
    if (Number.isNaN(ms)) return toast("Informe um início válido", "error");
    seek(ms);
  }

  async function baixar() {
    if (!summary) return;
    const start = zonedToMs(startField);
    const end = zonedToMs(endField);
    if (Number.isNaN(start) || Number.isNaN(end)) return toast("Informe início e fim", "error");
    setExporting(true);
    try {
      const r = await api.post<ExportGrant>(`/cameras/${summary.cameraId}/exports`, {
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
      });
      const a = document.createElement("a");
      a.href = r.downloadUrl;
      a.download = r.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast(
        r.recordedSeconds < r.seconds - 5
          ? `Download iniciado: ${r.filename} (${fmtDuration(r.recordedSeconds)} gravados de ${fmtDuration(r.seconds)})`
          : `Download iniciado: ${r.filename}`,
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : "Falha na exportação", "error");
    } finally {
      setExporting(false);
    }
  }

  const camera = cameras?.find((c) => c.id === cameraId);
  const tenantName =
    tenants.find((t) => t.id === tenantId)?.name ??
    auth.user?.tenant?.name ??
    cameras?.[0]?.tenantName ??
    "";

  const tree = (
    <CameraTree
      tenants={auth.isPlatform ? tenants : [{ id: tenantId ?? "", name: tenantName }]}
      tenantId={tenantId}
      onTenant={(id) => setTenantId(id)}
      locations={locations}
      cameras={cameras ?? []}
      focus={cameraId}
      collapsed={collapsed}
      onToggle={(k) => setCollapsed((c) => ({ ...c, [k]: !c[k] }))}
      onPick={(c) => {
        setCameraId(c.id);
        setTreeOpen(false);
      }}
    />
  );

  return (
    <div className="-mx-4 -my-5 flex min-h-[calc(100vh-4rem)] flex-col sm:-mx-6 sm:-my-6">
      {/* barra de ferramentas: câmera, período e exportação */}
      <div className="flex flex-wrap items-end gap-2 border-b border-line bg-white px-4 py-2.5 sm:px-6">
        <h1 className="sr-only">Gravações</h1>
        <button
          className="btn-secondary h-9 px-3 lg:hidden"
          onClick={() => setTreeOpen(true)}
          aria-label="Lista de câmeras"
        >
          <List size={16} /> Câmeras
        </button>
        {auth.isPlatform && (
          <select
            className="input h-9 w-auto min-w-40"
            value={tenantId ?? ""}
            onChange={(e) => setTenantId(e.target.value)}
            aria-label="Cliente"
          >
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        )}
        <div className="min-w-0 self-center text-sm font-semibold text-slate-800">
          {camera ? `${camera.code} · ${camera.name}` : ""}
        </div>
        <div className="ml-auto flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-0.5 text-xs text-muted">
            Início
            <input
              type="datetime-local"
              step={1}
              className="input h-9 w-auto"
              value={startField}
              onChange={(e) => setStartField(e.target.value)}
              disabled={!summary}
              aria-label="Início"
            />
          </label>
          <label className="flex flex-col gap-0.5 text-xs text-muted">
            Fim
            <input
              type="datetime-local"
              step={1}
              className="input h-9 w-auto"
              value={endField}
              onChange={(e) => setEndField(e.target.value)}
              disabled={!summary}
              aria-label="Fim"
            />
          </label>
          <button className="btn-secondary h-9 px-3" onClick={buscar} disabled={!summary}>
            <Search size={16} /> Buscar
          </button>
          {summary?.canExport && (
            <button
              className="btn-primary h-9 px-3"
              onClick={() => void baixar()}
              disabled={exporting}
            >
              <Download size={16} /> {exporting ? "Preparando…" : "Baixar MP4"}
            </button>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="scroll-thin hidden w-64 shrink-0 overflow-y-auto border-r border-line bg-white p-3 lg:block">
          {tree}
        </aside>
        {treeOpen && (
          <div className="fixed inset-0 z-50 flex lg:hidden" onClick={() => setTreeOpen(false)}>
            <div
              className="scroll-thin h-full w-72 max-w-[85%] overflow-y-auto bg-white p-3"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-semibold">Câmeras com gravação</span>
                <button
                  className="icon-btn"
                  onClick={() => setTreeOpen(false)}
                  aria-label="Fechar lista"
                >
                  <X size={16} />
                </button>
              </div>
              {tree}
            </div>
            <div className="flex-1 bg-slate-900/50" />
          </div>
        )}

        <section className="min-w-0 flex-1 space-y-3 p-3 sm:p-4">
          <ErrorBox error={error} />
          {!cameras ? (
            <div className="card">
              <Loading />
            </div>
          ) : !cameraId ? (
            <div className="card">
              <Empty
                icon={<Film size={40} />}
                title="Nenhuma câmera com gravação"
                text="Não há câmeras com gravação liberadas para você neste cliente."
              />
            </div>
          ) : denied ? (
            <div className="card">
              <Empty
                icon={<Lock size={40} />}
                title="Sem permissão para gravações"
                text="Você não tem a permissão “pode reproduzir” nesta câmera. Peça ao administrador do seu cliente."
              />
            </div>
          ) : !summary ? (
            <div className="card">
              <Loading />
            </div>
          ) : (
            <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_280px]">
              <div className="min-w-0 space-y-3">
                <RecordingPlayer
                  cameraId={summary.cameraId}
                  label={`${summary.code} · ${summary.name}`}
                  spans={spans}
                  onTime={onTime}
                  handle={player}
                />
                {timeline ? (
                  <RecordingTimeline
                    day={day}
                    spans={spans}
                    gaps={timeline.gaps}
                    cursor={cursor}
                    onSeek={seek}
                  />
                ) : (
                  <div className="card">
                    <Loading />
                  </div>
                )}
              </div>
              <div className="space-y-3">
                <MonthCalendar
                  month={month}
                  onMonth={setMonth}
                  selected={day}
                  today={today}
                  days={days}
                  onPick={(d) => setDay(d)}
                />
                <div className="card space-y-1.5 p-3 text-xs" data-testid="recording-info">
                  <Info k="Dia" v={day.split("-").reverse().join("/")} />
                  <Info
                    k="Gravado no dia"
                    v={fmtDuration(spans.reduce((a, s) => a + s.to - s.from, 0) / 1000)}
                  />
                  <Info k="Lacunas no dia" v={String(timeline?.gaps.length ?? "—")} />
                  <Info
                    k="Retenção"
                    v={summary.retentionHours ? `${summary.retentionHours} h` : "—"}
                  />
                  <Info k="Mais antiga" v={fmtDateTime(summary.oldest)} />
                  <Info k="Posição" v={cursor ? fmtClock(cursor) : "—"} />
                  <Info k="Exportação" v={summary.canExport ? "Permitida" : "Sem permissão"} />
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Info({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted">{k}</span>
      <span className="text-right font-medium text-slate-700">{v}</span>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <Gravacoes />
    </Suspense>
  );
}
