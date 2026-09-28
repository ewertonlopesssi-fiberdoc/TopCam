"use client";

import {
  Building2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Expand,
  FolderTree,
  List,
  MapPin,
  MonitorPlay,
  X,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LivePlayer,
  type LiveCameraInfo,
  type LiveMode,
  type LiveSession,
} from "@/components/live-player";
import { Empty, ErrorBox, Loading } from "@/components/ui";
import { api, qs, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";

interface Camera extends LiveCameraInfo {
  tenantId: string;
  tenantName: string;
  locationId: string;
  locationName: string;
  groupId: string | null;
  groupName: string | null;
  enabled: boolean;
}
interface Group {
  id: string;
  name: string;
}
interface Location {
  id: string;
  name: string;
  groups: Group[];
}
interface Tenant {
  id: string;
  name: string;
  cameraCount?: number;
}

const LAYOUTS = [1, 4, 9, 16] as const;
type Layout = (typeof LAYOUTS)[number];

/** Colunas do mosaico por largura (celular no máximo 2, tablet no máximo 3). */
const GRID: Record<Layout, string> = {
  1: "grid-cols-1",
  4: "grid-cols-1 sm:grid-cols-2",
  9: "grid-cols-2 md:grid-cols-3",
  16: "grid-cols-2 md:grid-cols-3 xl:grid-cols-4",
};

const STATUS_DOT: Record<string, string> = {
  ao_vivo: "bg-green-500",
  gravando: "bg-green-500",
  recebendo: "bg-amber-400",
  validando: "bg-amber-400",
  conectando: "bg-amber-400",
  offline: "bg-red-500",
  erro: "bg-red-500",
  aguardando_transmissao: "bg-slate-400",
  desabilitada: "bg-slate-300",
};

async function allCameras(tenantId: string | null): Promise<Camera[]> {
  const out: Camera[] = [];
  for (let page = 1; page <= 50; page++) {
    const r = await api.get<Page<Camera>>(
      `/cameras${qs({ tenantId: tenantId ?? undefined, pageSize: 100, page })}`,
    );
    out.push(...r.items);
    if (page >= r.pages) break;
  }
  return out;
}

function AoVivo() {
  const auth = useAuth();
  const params = useSearchParams();
  const focusParam = params.get("camera");

  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [tenantId, setTenantId] = useState<string | null>(auth.user?.tenant?.id ?? null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [cameras, setCameras] = useState<Camera[] | null>(null);
  const [locationId, setLocationId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [layout, setLayout] = useState<Layout>(4);
  const [page, setPage] = useState(0);
  const [focus, setFocus] = useState<string | null>(focusParam);
  const [mode, setMode] = useState<LiveMode>("auto");
  const [sessions, setSessions] = useState<Record<string, LiveSession>>({});
  const [error, setError] = useState<unknown>(null);
  const [treeOpen, setTreeOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const grid = useRef<HTMLDivElement>(null);

  // ---- clientes (equipe da plataforma) e câmera pedida na URL
  useEffect(() => {
    if (!auth.isPlatform) return;
    api
      .get<Page<Tenant>>("/tenants?status=active&pageSize=100")
      .then(async (r) => {
        setTenants(r.items);
        if (focusParam) {
          const cam = await api.get<Camera>(`/cameras/${focusParam}`).catch(() => null);
          if (cam) return setTenantId(cam.tenantId);
        }
        setTenantId((cur) => cur ?? r.items[0]?.id ?? null);
      })
      .catch(setError);
  }, [auth.isPlatform, focusParam]);

  // ---- locais/grupos e câmeras do cliente (estados atualizados a cada 10 s)
  const load = useCallback(async () => {
    if (auth.isPlatform && !tenantId) return;
    try {
      const [locs, cams] = await Promise.all([
        api.get<{ items: Location[] }>(`/locations${qs({ tenantId: tenantId ?? undefined })}`),
        allCameras(tenantId),
      ]);
      setLocations(locs.items);
      setCameras(cams.filter((c) => c.enabled));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [tenantId, auth.isPlatform]);

  useEffect(() => {
    setCameras(null);
    setLocationId("");
    setGroupId("");
    setPage(0);
    void load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  // ---- câmeras filtradas e página do mosaico
  const filtered = useMemo(
    () =>
      (cameras ?? []).filter(
        (c) => (!locationId || c.locationId === locationId) && (!groupId || c.groupId === groupId),
      ),
    [cameras, locationId, groupId],
  );
  const focused = focus
    ? (filtered.find((c) => c.id === focus) ?? cameras?.find((c) => c.id === focus))
    : null;
  const size = focused ? 1 : layout;
  const pages = Math.max(1, Math.ceil(filtered.length / size));
  const current = Math.min(page, pages - 1);
  const visible = focused ? [focused] : filtered.slice(current * size, current * size + size);
  const visibleKey = visible.map((c) => c.id).join(",");

  // ---- endereços temporários só das câmeras visíveis
  useEffect(() => {
    const missing = visible.map((c) => c.id).filter((id) => !sessions[id]);
    if (!missing.length) return;
    api
      .post<{ items: LiveSession[] }>("/live/sessions", { cameraIds: missing })
      .then((r) =>
        setSessions((s) => ({ ...s, ...Object.fromEntries(r.items.map((i) => [i.cameraId, i])) })),
      )
      .catch(setError);
  }, [visibleKey]);

  const renew = useCallback(async (cameraId: string) => {
    try {
      const r = await api.post<{ items: LiveSession[] }>("/live/sessions", {
        cameraIds: [cameraId],
      });
      setSessions((s) => ({ ...s, [cameraId]: r.items[0]! }));
    } catch {
      /* a próxima tentativa do player pede de novo */
    }
  }, []);

  const groupsOf = locations.find((l) => l.id === locationId)?.groups ?? [];
  const allGroups = locationId ? groupsOf : locations.flatMap((l) => l.groups);
  const tenantName =
    tenants.find((t) => t.id === tenantId)?.name ??
    auth.user?.tenant?.name ??
    cameras?.[0]?.tenantName ??
    "";

  function pick(cam: Camera) {
    setFocus(cam.id);
    setTreeOpen(false);
  }

  const tree = (
    <CameraTree
      tenants={auth.isPlatform ? tenants : [{ id: tenantId ?? "", name: tenantName }]}
      tenantId={tenantId}
      onTenant={(id) => {
        setTenantId(id);
        setFocus(null);
      }}
      locations={locations}
      cameras={cameras ?? []}
      focus={focus}
      collapsed={collapsed}
      onToggle={(k) => setCollapsed((c) => ({ ...c, [k]: !c[k] }))}
      onPick={pick}
    />
  );

  return (
    <div className="-mx-4 -my-5 flex min-h-[calc(100vh-4rem)] flex-col sm:-mx-6 sm:-my-6">
      {/* barra de ferramentas (como na referência) */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-white px-4 py-2.5 sm:px-6">
        <h1 className="sr-only">Ao Vivo</h1>
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
            onChange={(e) => {
              setTenantId(e.target.value);
              setFocus(null);
            }}
            aria-label="Cliente"
          >
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        )}
        <select
          className="input h-9 w-auto min-w-36"
          value={locationId}
          onChange={(e) => {
            setLocationId(e.target.value);
            setGroupId("");
            setPage(0);
            setFocus(null);
          }}
          aria-label="Local"
        >
          <option value="">Todos os locais</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div
            className="flex overflow-hidden rounded-lg border border-line"
            role="group"
            aria-label="Mosaico"
          >
            {LAYOUTS.map((n) => (
              <button
                key={n}
                className={`h-9 w-10 text-sm font-medium ${
                  layout === n && !focused
                    ? "bg-brand-600 text-white"
                    : "bg-white text-slate-600 hover:bg-slate-50"
                }`}
                onClick={() => {
                  setLayout(n);
                  setPage(0);
                  setFocus(null);
                }}
                aria-pressed={layout === n && !focused}
                aria-label={`Mosaico com ${n}`}
              >
                {n}
              </button>
            ))}
          </div>
          <button
            className="btn-secondary h-9 px-3"
            onClick={() => void grid.current?.requestFullscreen()}
          >
            <Expand size={16} /> <span className="hidden sm:inline">Tela Cheia</span>
          </button>
          <select
            className="input h-9 w-auto min-w-36"
            value={groupId}
            onChange={(e) => {
              setGroupId(e.target.value);
              setPage(0);
              setFocus(null);
            }}
            aria-label="Grupo"
          >
            <option value="">Todos os Grupos</option>
            {allGroups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
          <select
            className="input h-9 w-auto"
            value={mode}
            onChange={(e) => setMode(e.target.value as LiveMode)}
            aria-label="Transmissão"
            title="Automático: WebRTC (menor atraso) e, se não conectar, HLS"
          >
            <option value="auto">Automático</option>
            <option value="webrtc">WebRTC</option>
            <option value="hls">HLS</option>
          </select>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* árvore Empresa › Local › Grupo (computador) */}
        <aside className="scroll-thin hidden w-64 shrink-0 overflow-y-auto border-r border-line bg-white p-3 lg:block">
          {tree}
        </aside>

        {/* árvore em gaveta (tablet/celular) */}
        {treeOpen && (
          <div className="fixed inset-0 z-50 flex lg:hidden" onClick={() => setTreeOpen(false)}>
            <div
              className="scroll-thin h-full w-72 max-w-[85%] overflow-y-auto bg-white p-3"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-semibold">Câmeras</span>
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

        <section className="min-w-0 flex-1 bg-slate-900 p-2 sm:p-3" ref={grid}>
          <ErrorBox error={error} />
          {!cameras ? (
            <div className="card">
              <Loading />
            </div>
          ) : filtered.length === 0 && !focused ? (
            <div className="card">
              <Empty
                icon={<MonitorPlay size={40} />}
                title="Nenhuma câmera para exibir"
                text="Não há câmeras liberadas para você neste filtro."
              />
            </div>
          ) : (
            <>
              {(focused || pages > 1) && (
                <div className="mb-2 flex items-center gap-2 text-sm text-slate-200">
                  {focused ? (
                    <button
                      className="flex items-center gap-1 rounded px-2 py-1 hover:bg-white/10"
                      onClick={() => setFocus(null)}
                    >
                      <ChevronLeft size={16} /> Voltar ao mosaico
                    </button>
                  ) : (
                    <>
                      <button
                        className="rounded p-1 hover:bg-white/10 disabled:opacity-30"
                        onClick={() => setPage(current - 1)}
                        disabled={current === 0}
                        aria-label="Página anterior"
                      >
                        <ChevronLeft size={18} />
                      </button>
                      <span>
                        {current + 1} / {pages}
                      </span>
                      <button
                        className="rounded p-1 hover:bg-white/10 disabled:opacity-30"
                        onClick={() => setPage(current + 1)}
                        disabled={current >= pages - 1}
                        aria-label="Próxima página"
                      >
                        <ChevronRight size={18} />
                      </button>
                      <span className="text-slate-400">· {filtered.length} câmeras</span>
                    </>
                  )}
                </div>
              )}
              <div className={`grid gap-2 ${GRID[size as Layout]}`}>
                {visible.map((c) => (
                  <LivePlayer
                    key={`${c.id}-${mode}`}
                    camera={c}
                    session={sessions[c.id]}
                    mode={mode}
                    onRenew={renew}
                    onFocus={(id) => setFocus(focus === id ? null : id)}
                  />
                ))}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function CameraTree({
  tenants,
  tenantId,
  onTenant,
  locations,
  cameras,
  focus,
  collapsed,
  onToggle,
  onPick,
}: {
  tenants: Tenant[];
  tenantId: string | null;
  onTenant: (id: string) => void;
  locations: Location[];
  cameras: Camera[];
  focus: string | null;
  collapsed: Record<string, boolean>;
  onToggle: (key: string) => void;
  onPick: (c: Camera) => void;
}) {
  const camItem = (c: Camera) => (
    <li key={c.id}>
      <button
        className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[13px] hover:bg-slate-50 ${
          focus === c.id ? "bg-brand-50 font-medium text-brand-700" : "text-slate-700"
        }`}
        onClick={() => onPick(c)}
        title={`${c.code} - ${c.name}`}
      >
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[c.status] ?? "bg-slate-400"}`}
        />
        <span className="truncate">{c.name}</span>
      </button>
    </li>
  );
  return (
    <nav aria-label="Câmeras por local" className="text-sm">
      <ul className="space-y-0.5">
        {tenants.map((t) => {
          const open = t.id === tenantId;
          return (
            <li key={t.id}>
              <button
                className="flex w-full items-center gap-1.5 rounded px-1 py-1.5 font-semibold text-slate-800 hover:bg-slate-50"
                onClick={() => onTenant(t.id)}
              >
                {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                <Building2 size={15} className="text-slate-400" />
                <span className="truncate">{t.name}</span>
                {open && (
                  <span className="ml-auto text-xs font-normal text-muted">({cameras.length})</span>
                )}
              </button>
              {open && (
                <ul className="ml-3 space-y-0.5 border-l border-line pl-2">
                  {locations.map((l) => {
                    const cams = cameras.filter((c) => c.locationId === l.id);
                    const k = `loc:${l.id}`;
                    return (
                      <li key={l.id}>
                        <button
                          className="flex w-full items-center gap-1.5 rounded px-1 py-1 font-medium text-slate-700 hover:bg-slate-50"
                          onClick={() => onToggle(k)}
                        >
                          {collapsed[k] ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                          <MapPin size={14} className="text-slate-400" />
                          <span className="truncate">{l.name}</span>
                          <span className="ml-auto text-xs font-normal text-muted">
                            ({cams.length})
                          </span>
                        </button>
                        {!collapsed[k] && (
                          <ul className="ml-3 space-y-0.5">
                            {l.groups.map((g) => {
                              const gc = cams.filter((c) => c.groupId === g.id);
                              if (!gc.length) return null;
                              return (
                                <li key={g.id}>
                                  <div className="flex items-center gap-1.5 px-1 pt-1 text-xs text-muted">
                                    <FolderTree size={12} /> {g.name}
                                  </div>
                                  <ul>{gc.map(camItem)}</ul>
                                </li>
                              );
                            })}
                            {cams.filter((c) => !c.groupId).map(camItem)}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <AoVivo />
    </Suspense>
  );
}
