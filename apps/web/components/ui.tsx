"use client";

import { AlertTriangle, Check, ChevronLeft, ChevronRight, Copy, Loader2, X } from "lucide-react";
import {
  Children,
  Fragment,
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { ApiError } from "@/lib/api";
import type { Tone } from "@/lib/format";

// ------------------------------------------------------------------ Badge
const TONES: Record<Tone, string> = {
  green: "bg-green-50 text-green-700 ring-green-200",
  red: "bg-red-50 text-red-700 ring-red-200",
  amber: "bg-amber-50 text-amber-700 ring-amber-200",
  slate: "bg-slate-100 text-slate-600 ring-slate-200",
  blue: "bg-brand-50 text-brand-700 ring-brand-100",
};
const DOTS: Record<Tone, string> = {
  green: "bg-green-500",
  red: "bg-red-500",
  amber: "bg-amber-500",
  slate: "bg-slate-400",
  blue: "bg-brand-500",
};

export function Badge({
  tone,
  children,
  dot,
}: {
  tone: Tone;
  children: React.ReactNode;
  dot?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[tone]}`}
    >
      {dot && <span className={`h-1.5 w-1.5 rounded-full ${DOTS[tone]}`} />}
      {children}
    </span>
  );
}

// ------------------------------------------------------------------ Page header
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-xl font-semibold text-ink sm:text-2xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ Field
/**
 * Rótulo associado ao campo por id (htmlFor), para leitores de tela e testes:
 * o nome acessível do campo é só o texto do rótulo.
 */
export function Field({
  label,
  children,
  hint,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
  className?: string;
}) {
  const autoId = useId();
  const child = Children.only(children);
  const el = isValidElement<{ id?: string }>(child) ? child : null;
  const id = el?.props.id ?? `f${autoId.replace(/:/g, "")}`;
  return (
    <div className={className}>
      <label htmlFor={id} className="label">
        {label}
      </label>
      {el ? cloneElement(el, { id }) : children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </div>
  );
}

// ------------------------------------------------------------------ Modal e painel lateral
export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-0 sm:items-center sm:p-4"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-white shadow-xl sm:rounded-2xl ${wide ? "sm:max-w-3xl" : "sm:max-w-lg"}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-base font-semibold">{title}</h2>
          <button className="icon-btn border-0" onClick={onClose} aria-label="Fechar">
            <X size={18} />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export function Drawer({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/40" onMouseDown={onClose}>
      <aside
        role="dialog"
        aria-label={title}
        className="flex h-full w-full max-w-md flex-col bg-white shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-base font-semibold">{title}</h2>
          <button className="icon-btn border-0" onClick={onClose} aria-label="Fechar">
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </aside>
    </div>
  );
}

// ------------------------------------------------------------------ Confirmação
export function Confirm({
  open,
  title,
  message,
  confirmLabel = "Confirmar",
  danger,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button
            className={danger ? "btn-danger" : "btn-primary"}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy && <Loader2 size={16} className="animate-spin" />}
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="flex gap-3">
        {danger && <AlertTriangle className="mt-0.5 shrink-0 text-red-500" size={20} />}
        <div className="text-sm text-slate-700">{message}</div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ Paginação
export function Pagination({
  page,
  pages,
  total,
  pageSize,
  onPage,
}: {
  page: number;
  pages: number;
  total: number;
  pageSize: number;
  onPage: (p: number) => void;
}) {
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const nums: (number | "…")[] = [];
  for (let i = 1; i <= pages; i++) {
    if (i === 1 || i === pages || Math.abs(i - page) <= 1) nums.push(i);
    else if (nums[nums.length - 1] !== "…") nums.push("…");
  }
  return (
    <div className="flex flex-col items-center justify-between gap-3 border-t border-line px-4 py-3 text-sm text-muted sm:flex-row">
      <span>
        Mostrando {from} a {to} de {total} registro{total === 1 ? "" : "s"}
      </span>
      <div className="flex items-center gap-1">
        <button
          className="icon-btn"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          aria-label="Página anterior"
        >
          <ChevronLeft size={16} />
        </button>
        {nums.map((n, i) =>
          n === "…" ? (
            <span key={`e${i}`} className="px-2">
              …
            </span>
          ) : (
            <button
              key={n}
              onClick={() => onPage(n)}
              className={`h-8 min-w-8 rounded-md px-2 text-sm ${n === page ? "bg-brand-600 font-semibold text-white" : "border border-line bg-white text-slate-700 hover:bg-slate-50"}`}
            >
              {n}
            </button>
          ),
        )}
        <button
          className="icon-btn"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
          aria-label="Próxima página"
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Estados vazios / carregando
export function Loading({ label = "Carregando…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted">
      <Loader2 size={18} className="animate-spin" /> {label}
    </div>
  );
}

export function Empty({
  icon,
  title,
  text,
}: {
  icon?: React.ReactNode;
  title: string;
  text?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
      {icon && <div className="text-slate-300">{icon}</div>}
      <p className="font-medium text-slate-700">{title}</p>
      {text && <p className="max-w-md text-sm text-muted">{text}</p>}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as ApiError;
  return (
    <div
      role="alert"
      className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
    >
      {e.message ?? "Erro inesperado"}
      {e.details && (
        <ul className="mt-1 list-disc pl-5 text-xs">
          {e.details.map((d) => (
            <li key={d.campo}>
              {d.campo}: {d.erro}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Copiar
export function CopyButton({ value, label = "Copiar" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn-secondary h-9 px-3"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
        } catch {
          const ta = document.createElement("textarea");
          ta.value = value;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        }
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check size={16} className="text-green-600" /> : <Copy size={16} />}
      {done ? "Copiado" : label}
    </button>
  );
}

// ------------------------------------------------------------------ Toast
interface ToastMsg {
  id: number;
  text: string;
  tone: "ok" | "error";
}
const ToastCtx = createContext<(text: string, tone?: "ok" | "error") => void>(() => undefined);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastMsg[]>([]);
  const seq = useRef(0);
  const push = useCallback((text: string, tone: "ok" | "error" = "ok") => {
    const id = ++seq.current;
    setItems((x) => [...x, { id, text, tone }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex flex-col gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`pointer-events-auto rounded-lg px-4 py-3 text-sm text-white shadow-lg ${t.tone === "ok" ? "bg-slate-900" : "bg-red-600"}`}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

// ------------------------------------------------------------------ Tabela responsiva
export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => React.ReactNode;
  className?: string;
  /** Oculta a coluna nas telas estreitas (vira cartão). */
  mobileHidden?: boolean;
}

/**
 * Tabela em telas médias/grandes; lista de cartões no celular.
 */
/** true quando a janela tem pelo menos `px` de largura (acompanha o redimensionamento). */
function useMinWidth(px: number): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${px}px)`);
    const on = () => setOk(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [px]);
  return ok;
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  actions,
  mobileTitle,
  expanded,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (r: T) => string;
  actions?: (r: T) => React.ReactNode;
  mobileTitle: (r: T) => React.ReactNode;
  /** Conteúdo aberto logo abaixo da linha (ex.: usuários do cliente); null = fechado. */
  expanded?: (r: T) => React.ReactNode | null;
}) {
  // A tabela (computador) e os cartões (celular) ficam os dois na página; o conteúdo
  // aberto só é montado na versão visível, para não duplicar formulários e consultas.
  const desktop = useMinWidth(768);
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="min-w-full divide-y divide-line">
          <thead className="bg-slate-50/60">
            <tr>
              {columns.map((c) => (
                <th key={c.key} className={`th ${c.className ?? ""}`}>
                  {c.header}
                </th>
              ))}
              {actions && <th className="th text-right">Ações</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => {
              const extra = desktop ? (expanded?.(r) ?? null) : null;
              return (
                <Fragment key={rowKey(r)}>
                  <tr className="hover:bg-slate-50/60">
                    {columns.map((c) => (
                      <td key={c.key} className={`td ${c.className ?? ""}`}>
                        {c.cell(r)}
                      </td>
                    ))}
                    {actions && (
                      <td className="td">
                        <div className="flex justify-end gap-1.5">{actions(r)}</div>
                      </td>
                    )}
                  </tr>
                  {extra && (
                    <tr className="bg-slate-50/70">
                      <td colSpan={columns.length + (actions ? 1 : 0)} className="px-4 py-3">
                        {extra}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <ul className="divide-y divide-line md:hidden">
        {rows.map((r) => (
          <li key={rowKey(r)} className="px-4 py-3">
            <div className="mb-2 font-medium">{mobileTitle(r)}</div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
              {columns
                .filter((c) => !c.mobileHidden)
                .map((c) => (
                  <div key={c.key} className="min-w-0">
                    <dt className="text-xs text-muted">{c.header}</dt>
                    <dd className="truncate">{c.cell(r)}</dd>
                  </div>
                ))}
            </dl>
            {actions && <div className="mt-3 flex flex-wrap gap-1.5">{actions(r)}</div>}
            {!desktop && expanded?.(r) && (
              <div className="mt-3 rounded-lg bg-slate-50 p-3">{expanded(r)}</div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
