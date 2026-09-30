"use client";

import {
  Ban,
  Building2,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Eye,
  Loader2,
  Pencil,
  Plus,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Confirm,
  DataTable,
  Drawer,
  Empty,
  ErrorBox,
  Field,
  Loading,
  Modal,
  PageHeader,
  Pagination,
  useToast,
  type Column,
} from "@/components/ui";
import {
  AccessResultModal,
  PasswordFields,
  emptyPassword,
  passwordPayload,
  passwordStateError,
  type AccessInfo,
  type PasswordState,
} from "@/components/password-fields";
import { ClientUsers } from "@/components/client-users";
import type { Role } from "@/components/user-modals";
import { api, qs, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { TENANT_STATUS, fmtBytes, fmtDateTime, pad3 } from "@/lib/format";

export interface Tenant {
  id: string;
  seq: number;
  slug: string;
  name: string;
  legalName: string | null;
  document: string | null;
  status: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  notes: string | null;
  planCode: string;
  planName: string;
  maxCameras: number;
  planStorageBytes: number;
  storageQuotaBytes: number | null;
  cameraCount: number;
  userCount: number;
  storageUsedBytes: number;
  createdAt: string;
}

interface Plan {
  code: string;
  name: string;
  maxCameras: number;
}

const empty = {
  name: "",
  legalName: "",
  document: "",
  planCode: "basico",
  contactName: "",
  contactEmail: "",
  contactPhone: "",
  notes: "",
};

function TenantForm({
  open,
  tenant,
  plans,
  mailEnabled,
  onClose,
  onSaved,
}: {
  open: boolean;
  tenant: Tenant | null;
  plans: Plan[];
  mailEnabled: boolean;
  onClose: () => void;
  onSaved: (access?: AccessInfo) => void;
}) {
  const [f, setF] = useState(empty);
  // Usuário administrador do cliente (só no cadastro): na maioria dos casos é o próprio cliente.
  const [withAdmin, setWithAdmin] = useState(true);
  const [adminEmail, setAdminEmail] = useState("");
  const [adminEmailTouched, setAdminEmailTouched] = useState(false);
  const [pw, setPw] = useState<PasswordState>(emptyPassword());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const toast = useToast();

  useEffect(() => {
    if (!open) return;
    setError(null);
    setF(
      tenant
        ? {
            name: tenant.name,
            legalName: tenant.legalName ?? "",
            document: tenant.document ?? "",
            planCode: tenant.planCode,
            contactName: tenant.contactName ?? "",
            contactEmail: tenant.contactEmail ?? "",
            contactPhone: tenant.contactPhone ?? "",
            notes: tenant.notes ?? "",
          }
        : { ...empty, planCode: plans[0]?.code ?? "basico" },
    );
    setWithAdmin(true);
    setAdminEmail("");
    setAdminEmailTouched(false);
    setPw(emptyPassword(mailEnabled));
  }, [open, tenant, plans, mailEnabled]);

  // O e-mail de acesso acompanha o e-mail de contato até ser editado à mão.
  const accessEmail = adminEmailTouched ? adminEmail : f.contactEmail;

  const set =
    (k: keyof typeof empty) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setF((x) => ({ ...x, [k]: e.target.value }));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (tenant) {
        await api.patch(`/tenants/${tenant.id}`, f);
        toast("Cliente atualizado");
        onSaved();
      } else if (withAdmin) {
        const local = passwordStateError(pw);
        if (local) throw new Error(local);
        if (!accessEmail.trim()) throw new Error("Informe o e-mail de acesso do administrador.");
        const p = passwordPayload(pw);
        const r = await api.post<{
          admin: {
            temporaryPassword?: string;
            mustChangePassword: boolean;
            mail: AccessInfo["mail"];
          };
        }>("/tenants", {
          ...f,
          admin: {
            email: accessEmail.trim(),
            ...(f.contactName.trim().length >= 2 ? { name: f.contactName.trim() } : {}),
            ...p,
          },
        });
        onSaved({
          email: accessEmail.trim().toLowerCase(),
          password: r.admin.temporaryPassword,
          mustChange: r.admin.mustChangePassword,
          mail: r.admin.mail,
        });
      } else {
        await api.post("/tenants", f);
        toast("Cliente criado");
        onSaved();
      }
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title={tenant ? `Editar cliente ${pad3(tenant.seq)}` : "Novo cliente"}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="btn-primary"
            onClick={save}
            disabled={busy || f.name.trim().length < 2}
          >
            {busy && <Loader2 size={16} className="animate-spin" />} Salvar
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Nome *" className="sm:col-span-2">
          <input className="input" value={f.name} onChange={set("name")} autoFocus />
        </Field>
        <Field label="Razão social">
          <input className="input" value={f.legalName} onChange={set("legalName")} />
        </Field>
        <Field label="CNPJ / CPF">
          <input className="input" value={f.document} onChange={set("document")} />
        </Field>
        <Field label="Plano *">
          <select className="input" value={f.planCode} onChange={set("planCode")}>
            {plans.map((p) => (
              <option key={p.code} value={p.code}>
                {p.name} (até {p.maxCameras} câmeras)
              </option>
            ))}
          </select>
        </Field>
        <Field label="Contato">
          <input className="input" value={f.contactName} onChange={set("contactName")} />
        </Field>
        <Field label="E-mail de contato">
          <input
            className="input"
            type="email"
            value={f.contactEmail}
            onChange={set("contactEmail")}
          />
        </Field>
        <Field label="Telefone">
          <input className="input" value={f.contactPhone} onChange={set("contactPhone")} />
        </Field>
        <Field label="Observações" className="sm:col-span-2">
          <textarea className="input h-20 py-2" value={f.notes} onChange={set("notes")} />
        </Field>
      </div>
      {!tenant && (
        <section className="mt-4 space-y-3 border-t border-line pt-4" data-testid="tenant-admin">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={withAdmin}
              onChange={(e) => setWithAdmin(e.target.checked)}
            />
            Criar o acesso do cliente (usuário administrador)
          </label>
          {withAdmin && (
            <>
              <Field
                label="E-mail de acesso *"
                hint="Usado para entrar no TopCam. Por padrão, o e-mail de contato."
              >
                <input
                  className="input"
                  type="email"
                  value={accessEmail}
                  onChange={(e) => (setAdminEmail(e.target.value), setAdminEmailTouched(true))}
                />
              </Field>
              <PasswordFields
                state={pw}
                onChange={setPw}
                mailEnabled={mailEnabled}
                optionalLabel="Em branco: o sistema gera"
              />
            </>
          )}
        </section>
      )}
    </Modal>
  );
}

export default function ClientesPage() {
  const auth = useAuth();
  const toast = useToast();
  const canWrite = auth.can("tenants.write");
  const [data, setData] = useState<Page<Tenant> | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [plan, setPlan] = useState("");
  const [page, setPage] = useState(1);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<Tenant | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [viewing, setViewing] = useState<Tenant | null>(null);
  const [toggling, setToggling] = useState<Tenant | null>(null);
  const [access, setAccess] = useState<AccessInfo | null>(null);
  const [openUsers, setOpenUsers] = useState<string | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [mailEnabled, setMailEnabled] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      setData(
        await api.get<Page<Tenant>>(`/tenants${qs({ search, status, plan, page, pageSize: 10 })}`),
      );
    } catch (err) {
      setError(err);
    }
  }, [search, status, plan, page]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    api
      .get<{ plans: Plan[]; roles: Role[] }>("/meta")
      .then((m) => (setPlans(m.plans), setRoles(m.roles)))
      .catch(() => undefined);
    api
      .get<{ enabled: boolean }>("/users/mail-status")
      .then((r) => setMailEnabled(r.enabled))
      .catch(() => undefined);
  }, []);

  const columns: Column<Tenant>[] = [
    {
      key: "id",
      header: "ID",
      cell: (t) => <span className="font-mono text-xs text-slate-500">{pad3(t.seq)}</span>,
      mobileHidden: true,
    },
    {
      key: "name",
      header: "Nome / Razão social",
      cell: (t) => (
        <div>
          <div className="font-medium">{t.name}</div>
          {t.legalName && <div className="text-xs text-muted">{t.legalName}</div>}
        </div>
      ),
      mobileHidden: true,
    },
    { key: "plan", header: "Plano", cell: (t) => t.planName },
    { key: "cams", header: "Câmeras", cell: (t) => `${t.cameraCount} / ${t.maxCameras}` },
    {
      key: "users",
      header: "Usuários",
      cell: (t) =>
        auth.can("users.read") ? (
          <button
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-sm font-medium text-brand-600 hover:bg-brand-50"
            aria-expanded={openUsers === t.id}
            aria-label={`Usuários de ${t.name}`}
            onClick={() => setOpenUsers(openUsers === t.id ? null : t.id)}
          >
            {openUsers === t.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {t.userCount}
          </button>
        ) : (
          t.userCount
        ),
    },
    {
      key: "storage",
      header: "Armazenamento",
      cell: (t) =>
        `${fmtBytes(t.storageUsedBytes)} / ${fmtBytes(t.storageQuotaBytes ?? t.planStorageBytes)}`,
    },
    {
      key: "status",
      header: "Status",
      cell: (t) => (
        <Badge tone={TENANT_STATUS[t.status]?.tone ?? "slate"}>
          {TENANT_STATUS[t.status]?.label ?? t.status}
        </Badge>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Clientes / Empresas"
        subtitle="Gerencie os clientes do sistema, seus planos, limites e status."
        actions={
          canWrite && (
            <button
              className="btn-primary"
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              <Plus size={16} /> Novo Cliente
            </button>
          )
        }
      />
      <ErrorBox error={error} />
      <div className="card">
        <div className="flex flex-col gap-3 border-b border-line p-4 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search
              size={16}
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400"
            />
            <input
              className="input pl-9 lg:max-w-sm"
              placeholder="Pesquisar cliente…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <div className="grid grid-cols-2 gap-3 lg:flex">
            <label className="flex items-center gap-2 text-sm text-muted">
              Status:
              <select
                className="input h-9 lg:w-40"
                value={status}
                onChange={(e) => (setStatus(e.target.value), setPage(1))}
              >
                <option value="">Todos</option>
                <option value="active">Ativo</option>
                <option value="suspended">Suspenso</option>
                <option value="cancelled">Cancelado</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm text-muted">
              Plano:
              <select
                className="input h-9 lg:w-40"
                value={plan}
                onChange={(e) => (setPlan(e.target.value), setPage(1))}
              >
                <option value="">Todos</option>
                {plans.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        {!data ? (
          <Loading />
        ) : data.items.length === 0 ? (
          <Empty
            icon={<Building2 size={40} />}
            title="Nenhum cliente encontrado"
            text="Ajuste os filtros ou cadastre um novo cliente."
          />
        ) : (
          <>
            <DataTable
              rows={data.items}
              columns={columns}
              rowKey={(t) => t.id}
              expanded={(t) =>
                openUsers === t.id ? (
                  <ClientUsers
                    tenant={{ id: t.id, name: t.name }}
                    roles={roles}
                    mailEnabled={mailEnabled}
                    onChanged={load}
                  />
                ) : null
              }
              mobileTitle={(t) => (
                <span>
                  <span className="mr-2 font-mono text-xs text-slate-400">{pad3(t.seq)}</span>
                  {t.name}
                </span>
              )}
              actions={(t) => (
                <>
                  <button
                    className="icon-btn"
                    title="Detalhes"
                    aria-label={`Detalhes de ${t.name}`}
                    onClick={() => setViewing(t)}
                  >
                    <Eye size={16} />
                  </button>
                  {canWrite && (
                    <button
                      className="icon-btn"
                      title="Editar"
                      aria-label={`Editar ${t.name}`}
                      onClick={() => {
                        setEditing(t);
                        setFormOpen(true);
                      }}
                    >
                      <Pencil size={16} />
                    </button>
                  )}
                  {canWrite && (
                    <button
                      className={`icon-btn ${t.status === "active" ? "hover:!text-red-600" : "hover:!text-green-600"}`}
                      title={t.status === "active" ? "Suspender" : "Reativar"}
                      aria-label={`${t.status === "active" ? "Suspender" : "Reativar"} ${t.name}`}
                      onClick={() => setToggling(t)}
                    >
                      {t.status === "active" ? <Ban size={16} /> : <CheckCircle2 size={16} />}
                    </button>
                  )}
                </>
              )}
            />
            <Pagination
              page={data.page}
              pages={data.pages}
              total={data.total}
              pageSize={data.pageSize}
              onPage={setPage}
            />
          </>
        )}
      </div>

      <TenantForm
        open={formOpen}
        tenant={editing}
        plans={plans}
        mailEnabled={mailEnabled}
        onClose={() => setFormOpen(false)}
        onSaved={(a) => {
          void load();
          if (!a) return;
          if (a.password || (a.mail && !a.mail.sent)) setAccess(a);
          else
            toast(
              a.mail?.sent ? `Cliente criado. Acesso enviado para ${a.email}` : "Cliente criado",
            );
        }}
      />
      <AccessResultModal access={access} onClose={() => setAccess(null)} />

      <Drawer open={!!viewing} title={viewing ? viewing.name : ""} onClose={() => setViewing(null)}>
        {viewing && (
          <dl className="space-y-3 text-sm">
            {[
              ["ID", pad3(viewing.seq)],
              ["Identificador", viewing.slug],
              ["Razão social", viewing.legalName],
              ["CNPJ / CPF", viewing.document],
              ["Plano", `${viewing.planName} (até ${viewing.maxCameras} câmeras)`],
              ["Câmeras", `${viewing.cameraCount} / ${viewing.maxCameras}`],
              ["Usuários", String(viewing.userCount)],
              [
                "Armazenamento",
                `${fmtBytes(viewing.storageUsedBytes)} / ${fmtBytes(viewing.storageQuotaBytes ?? viewing.planStorageBytes)}`,
              ],
              ["Contato", viewing.contactName],
              ["E-mail", viewing.contactEmail],
              ["Telefone", viewing.contactPhone],
              ["Cadastrado em", fmtDateTime(viewing.createdAt)],
              ["Observações", viewing.notes],
            ].map(([k, v]) => (
              <div key={k} className="grid grid-cols-3 gap-2">
                <dt className="text-muted">{k}</dt>
                <dd className="col-span-2 break-words">{v || "—"}</dd>
              </div>
            ))}
            <div className="grid grid-cols-3 gap-2">
              <dt className="text-muted">Status</dt>
              <dd className="col-span-2">
                <Badge tone={TENANT_STATUS[viewing.status]?.tone ?? "slate"}>
                  {TENANT_STATUS[viewing.status]?.label}
                </Badge>
              </dd>
            </div>
          </dl>
        )}
      </Drawer>

      <Confirm
        open={!!toggling}
        danger={toggling?.status === "active"}
        title={toggling?.status === "active" ? "Suspender cliente" : "Reativar cliente"}
        confirmLabel={toggling?.status === "active" ? "Suspender" : "Reativar"}
        message={
          toggling?.status === "active" ? (
            <>
              Ao suspender <b>{toggling?.name}</b>, os usuários do cliente perdem o acesso na hora e
              as câmeras deixam de ser aceitas (quem estiver transmitindo é desconectado). Nada é
              apagado.
            </>
          ) : (
            <>
              Reativar <b>{toggling?.name}</b>? Usuários e câmeras voltam a funcionar.
            </>
          )
        }
        onClose={() => setToggling(null)}
        onConfirm={async () => {
          if (!toggling) return;
          try {
            await api.post(`/tenants/${toggling.id}/status`, {
              status: toggling.status === "active" ? "suspended" : "active",
            });
            toast(toggling.status === "active" ? "Cliente suspenso" : "Cliente reativado");
            await load();
          } catch (err) {
            toast((err as Error).message, "error");
          }
        }}
      />
    </>
  );
}
