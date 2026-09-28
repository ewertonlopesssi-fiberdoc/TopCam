"use client";

import { FolderTree, Loader2, MapPin, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  Confirm,
  Empty,
  ErrorBox,
  Field,
  Loading,
  Modal,
  PageHeader,
  useToast,
} from "@/components/ui";
import { api, qs, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";

interface Group {
  id: string;
  locationId: string;
  name: string;
  cameraCount: number;
}
interface Location {
  id: string;
  tenantId: string;
  tenantName: string;
  name: string;
  address: string | null;
  cameraCount: number;
  groups: Group[];
}

type Editing =
  | { kind: "location"; item?: Location }
  | { kind: "group"; locationId: string; item?: Group }
  | null;

export default function GruposPage() {
  const auth = useAuth();
  const toast = useToast();
  const canWrite = auth.can("locations.write");
  const [tenants, setTenants] = useState<{ id: string; name: string }[]>([]);
  const [tenantId, setTenantId] = useState(auth.user?.tenant?.id ?? "");
  const [items, setItems] = useState<Location[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<unknown>(null);
  const [deleting, setDeleting] = useState<{
    kind: "location" | "group";
    id: string;
    name: string;
  } | null>(null);

  useEffect(() => {
    if (!auth.isPlatform) return;
    api
      .get<Page<{ id: string; name: string }>>("/tenants?pageSize=100")
      .then((r) => {
        setTenants(r.items);
        setTenantId((cur) => cur || r.items[0]?.id || "");
      })
      .catch(setError);
  }, [auth.isPlatform]);

  const load = useCallback(async () => {
    if (auth.isPlatform && !tenantId) return;
    try {
      setError(null);
      setItems(
        (
          await api.get<{ items: Location[] }>(
            `/locations${qs({ tenantId: auth.isPlatform ? tenantId : undefined })}`,
          )
        ).items,
      );
    } catch (err) {
      setError(err);
    }
  }, [tenantId, auth.isPlatform]);

  useEffect(() => {
    void load();
  }, [load]);

  function open(e: Editing) {
    setFormError(null);
    setEditing(e);
    if (e?.kind === "location") {
      setName(e.item?.name ?? "");
      setAddress(e.item?.address ?? "");
    } else if (e?.kind === "group") setName(e.item?.name ?? "");
  }

  async function save() {
    if (!editing) return;
    setBusy(true);
    setFormError(null);
    try {
      if (editing.kind === "location") {
        if (editing.item)
          await api.patch(`/locations/${editing.item.id}`, { name, address: address || null });
        else await api.post("/locations", { tenantId, name, address: address || null });
      } else if (editing.item) await api.patch(`/camera-groups/${editing.item.id}`, { name });
      else await api.post("/camera-groups", { locationId: editing.locationId, name });
      toast("Salvo");
      setEditing(null);
      await load();
    } catch (err) {
      setFormError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Grupos / Locais"
        subtitle="Organize as câmeras de cada cliente por local (ex.: Matriz, Filial) e grupo (ex.: Frente, Estoque)."
        actions={
          canWrite && (
            <button
              className="btn-primary"
              onClick={() => open({ kind: "location" })}
              disabled={!tenantId}
            >
              <Plus size={16} /> Novo Local
            </button>
          )
        }
      />
      {auth.isPlatform && (
        <div className="mb-4 max-w-sm">
          <Field label="Cliente">
            <select
              className="input"
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
            >
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}
      <ErrorBox error={error} />
      {!items ? (
        <div className="card">
          <Loading />
        </div>
      ) : items.length === 0 ? (
        <div className="card">
          <Empty
            icon={<FolderTree size={40} />}
            title="Nenhum local cadastrado"
            text="Cadastre um local para começar a organizar as câmeras."
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {items.map((l) => (
            <section key={l.id} className="card flex flex-col">
              <header className="flex items-start gap-3 border-b border-line p-4">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                  <MapPin size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="truncate font-semibold">{l.name}</h2>
                  <p className="truncate text-xs text-muted">
                    {l.address || "Sem endereço"} · {l.cameraCount} câmera(s)
                  </p>
                </div>
                {canWrite && (
                  <div className="flex gap-1">
                    <button
                      className="icon-btn"
                      aria-label={`Editar local ${l.name}`}
                      onClick={() => open({ kind: "location", item: l })}
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      className="icon-btn hover:!text-red-600"
                      aria-label={`Excluir local ${l.name}`}
                      onClick={() => setDeleting({ kind: "location", id: l.id, name: l.name })}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                )}
              </header>
              <ul className="flex-1 divide-y divide-line">
                {l.groups.length === 0 && (
                  <li className="px-4 py-3 text-sm text-muted">Nenhum grupo neste local.</li>
                )}
                {l.groups.map((g) => (
                  <li key={g.id} className="flex items-center gap-2 px-4 py-2.5 text-sm">
                    <FolderTree size={15} className="text-slate-400" />
                    <span className="flex-1 truncate">{g.name}</span>
                    <span className="text-xs text-muted">{g.cameraCount} câm.</span>
                    {canWrite && (
                      <>
                        <button
                          className="icon-btn h-7 w-7"
                          aria-label={`Editar grupo ${g.name}`}
                          onClick={() => open({ kind: "group", locationId: l.id, item: g })}
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          className="icon-btn h-7 w-7 hover:!text-red-600"
                          aria-label={`Excluir grupo ${g.name}`}
                          onClick={() => setDeleting({ kind: "group", id: g.id, name: g.name })}
                        >
                          <Trash2 size={14} />
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
              {canWrite && (
                <div className="border-t border-line p-3">
                  <button
                    className="btn-secondary h-9 w-full text-xs"
                    onClick={() => open({ kind: "group", locationId: l.id })}
                  >
                    <Plus size={14} /> Adicionar grupo
                  </button>
                </div>
              )}
            </section>
          ))}
        </div>
      )}

      <Modal
        open={!!editing}
        title={`${editing?.item ? "Editar" : "Novo"} ${editing?.kind === "group" ? "grupo" : "local"}`}
        onClose={() => setEditing(null)}
        footer={
          <>
            <button className="btn-secondary" onClick={() => setEditing(null)}>
              Cancelar
            </button>
            <button className="btn-primary" onClick={save} disabled={busy || !name.trim()}>
              {busy && <Loader2 size={16} className="animate-spin" />} Salvar
            </button>
          </>
        }
      >
        <ErrorBox error={formError} />
        <div className="space-y-3">
          <Field label="Nome *">
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </Field>
          {editing?.kind === "location" && (
            <Field label="Endereço">
              <input
                className="input"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
              />
            </Field>
          )}
        </div>
      </Modal>

      <Confirm
        open={!!deleting}
        danger
        title={`Excluir ${deleting?.kind === "group" ? "grupo" : "local"}`}
        confirmLabel="Excluir"
        message={
          <>
            Excluir <b>{deleting?.name}</b>? Só é possível se não houver câmeras nele.
          </>
        }
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          try {
            await api.del(
              `/${deleting!.kind === "group" ? "camera-groups" : "locations"}/${deleting!.id}`,
            );
            toast("Excluído");
            await load();
          } catch (err) {
            toast((err as Error).message, "error");
          }
        }}
      />
    </>
  );
}
