"use client";

import {
  Bell,
  Building2,
  Camera,
  ChevronDown,
  ClipboardList,
  Cog,
  Film,
  FileBarChart,
  FolderTree,
  HardDrive,
  LayoutDashboard,
  LogOut,
  Menu,
  MonitorPlay,
  Search,
  Server,
  ShieldCheck,
  Siren,
  UserRound,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { initials } from "@/lib/format";

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  show: (a: ReturnType<typeof useAuth>) => boolean;
}

/** Mesma ordem do menu das telas de referência. */
export const NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, show: () => true },
  {
    href: "/clientes",
    label: "Clientes",
    icon: Building2,
    show: (a) => a.can("tenants.write") || a.isPlatform,
  },
  { href: "/usuarios", label: "Usuários", icon: Users, show: (a) => a.can("users.read") },
  {
    href: "/grupos",
    label: "Grupos / Locais",
    icon: FolderTree,
    show: (a) => a.can("locations.read"),
  },
  { href: "/cameras", label: "Câmeras", icon: Camera, show: (a) => a.can("cameras.read") },
  { href: "/ao-vivo", label: "Ao Vivo", icon: MonitorPlay, show: (a) => a.can("cameras.read") },
  { href: "/gravacoes", label: "Gravações", icon: Film, show: (a) => a.can("cameras.read") },
  { href: "/eventos", label: "Eventos e Alertas", icon: Siren, show: () => true },
  {
    href: "/armazenamento",
    label: "Armazenamento",
    icon: HardDrive,
    show: (a) => a.can("storage.read"),
  },
  { href: "/servidores", label: "Servidores", icon: Server, show: (a) => a.can("storage.read") },
  {
    href: "/relatorios",
    label: "Relatórios",
    icon: FileBarChart,
    show: (a) => a.can("audit.read"),
  },
  { href: "/auditoria", label: "Auditoria", icon: ClipboardList, show: (a) => a.can("audit.read") },
  { href: "/configuracoes", label: "Configurações", icon: Cog, show: () => true },
];

export function Logo({ compact }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 shadow-inner">
        <ShieldCheck size={20} className="text-white" />
      </div>
      {!compact && (
        <div className="leading-tight">
          <div className="text-[15px] font-bold tracking-wide text-white">TOPCAM</div>
          <div className="text-[10px] text-slate-400">Monitoramento de Câmeras</div>
        </div>
      )}
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const auth = useAuth();
  const pathname = usePathname();
  return (
    <nav
      aria-label="Menu principal"
      className="scroll-thin flex h-full flex-col overflow-y-auto bg-navy-900 px-3 py-4"
    >
      <div className="mb-6 px-2">
        <Logo />
      </div>
      <ul className="space-y-0.5">
        {NAV.filter((n) => n.show(auth)).map((n) => {
          const active = pathname === n.href || pathname.startsWith(`${n.href}/`);
          const Icon = n.icon;
          return (
            <li key={n.href}>
              <Link
                href={n.href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition ${
                  active
                    ? "bg-brand-600 font-medium text-white shadow"
                    : "text-slate-300 hover:bg-navy-800 hover:text-white"
                }`}
              >
                <Icon size={18} className="shrink-0" />
                {n.label}
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="mt-auto px-3 pt-6 text-[11px] text-slate-500">TopCam · laboratório</div>
    </nav>
  );
}

function Header({ onMenu }: { onMenu: () => void }) {
  const { user, signOut } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-line bg-white/95 px-4 backdrop-blur sm:px-6">
      <button className="icon-btn lg:hidden" onClick={onMenu} aria-label="Abrir menu">
        <Menu size={18} />
      </button>
      <form
        className="relative hidden max-w-sm flex-1 sm:block"
        onSubmit={(e) => {
          e.preventDefault();
          router.push(`/cameras?search=${encodeURIComponent(q)}`);
        }}
      >
        <Search
          size={16}
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400"
        />
        <input
          className="input h-9 bg-slate-50 pl-9"
          placeholder="Pesquisar câmeras…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Pesquisar câmeras"
        />
      </form>
      <div className="ml-auto flex items-center gap-2">
        <Link href="/eventos" className="icon-btn relative border-0" aria-label="Eventos e alertas">
          <Bell size={18} />
        </Link>
        <div className="relative">
          <button
            className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-50"
            onClick={() => setOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={open}
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-navy-800 text-sm font-semibold text-white">
              {initials(user?.name ?? "?")}
            </span>
            <span className="hidden text-left leading-tight sm:block">
              <span className="block max-w-40 truncate text-sm font-medium">{user?.name}</span>
              <span className="block text-xs text-muted">{user?.roleLabel}</span>
            </span>
            <ChevronDown size={16} className="text-slate-400" />
          </button>
          {open && (
            <div
              role="menu"
              className="absolute right-0 mt-2 w-56 rounded-xl border border-line bg-white p-1.5 shadow-lg"
              onMouseLeave={() => setOpen(false)}
            >
              <div className="border-b border-line px-3 py-2 text-xs text-muted">
                {user?.email}
                {user?.tenant && (
                  <div className="font-medium text-slate-600">{user.tenant.name}</div>
                )}
              </div>
              <Link
                role="menuitem"
                href="/configuracoes"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-slate-50"
              >
                <UserRound size={16} /> Minha conta
              </Link>
              <button
                role="menuitem"
                onClick={() => void signOut()}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-red-600 hover:bg-red-50"
              >
                <LogOut size={16} /> Sair
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const [drawer, setDrawer] = useState(false);
  const pathname = usePathname();
  useEffect(() => setDrawer(false), [pathname]);
  return (
    <div className="min-h-screen lg:pl-60">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 lg:block">
        <Sidebar />
      </aside>
      {drawer && (
        <div className="fixed inset-0 z-50 flex lg:hidden" onClick={() => setDrawer(false)}>
          <div className="w-64 max-w-[80%]" onClick={(e) => e.stopPropagation()}>
            <Sidebar onNavigate={() => setDrawer(false)} />
          </div>
          <div className="flex-1 bg-slate-900/50">
            <button className="m-3 rounded-lg bg-white/10 p-2 text-white" aria-label="Fechar menu">
              <X size={18} />
            </button>
          </div>
        </div>
      )}
      <Header onMenu={() => setDrawer(true)} />
      <main className="mx-auto w-full max-w-[1600px] px-4 py-5 sm:px-6 sm:py-6">{children}</main>
    </div>
  );
}
