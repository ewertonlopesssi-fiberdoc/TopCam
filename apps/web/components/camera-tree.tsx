"use client";

import { Building2, ChevronDown, ChevronRight, FolderTree, MapPin } from "lucide-react";
import type { LiveCameraInfo } from "@/components/live-player";
import { api, qs, type Page } from "@/lib/api";

/** Árvore Empresa › Local › Grupo › Câmera, usada no Ao Vivo e em Gravações. */

export interface TreeCamera extends LiveCameraInfo {
  tenantId: string;
  tenantName: string;
  locationId: string;
  locationName: string;
  groupId: string | null;
  groupName: string | null;
  enabled: boolean;
  recordingEnabled?: boolean;
}
export interface TreeGroup {
  id: string;
  name: string;
}
export interface TreeLocation {
  id: string;
  name: string;
  groups: TreeGroup[];
}
export interface TreeTenant {
  id: string;
  name: string;
  cameraCount?: number;
}

export const STATUS_DOT: Record<string, string> = {
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

export async function allCameras(tenantId: string | null): Promise<TreeCamera[]> {
  const out: TreeCamera[] = [];
  for (let page = 1; page <= 50; page++) {
    const r = await api.get<Page<TreeCamera>>(
      `/cameras${qs({ tenantId: tenantId ?? undefined, pageSize: 100, page })}`,
    );
    out.push(...r.items);
    if (page >= r.pages) break;
  }
  return out;
}

export function CameraTree({
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
  tenants: TreeTenant[];
  tenantId: string | null;
  onTenant: (id: string) => void;
  locations: TreeLocation[];
  cameras: TreeCamera[];
  focus: string | null;
  collapsed: Record<string, boolean>;
  onToggle: (key: string) => void;
  onPick: (c: TreeCamera) => void;
}) {
  const camItem = (c: TreeCamera) => (
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
