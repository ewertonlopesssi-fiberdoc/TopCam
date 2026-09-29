"use client";

import { Building2, Camera, CameraOff, Users, Wifi } from "lucide-react";
import { Monitor } from "@/components/dashboard-monitor";
import Link from "next/link";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/ui";
import { api, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";

interface Stat {
  label: string;
  value: number | null;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  tone: string;
  href?: string;
}

export default function DashboardPage() {
  const auth = useAuth();
  const [stats, setStats] = useState<Stat[]>([]);

  useEffect(() => {
    const total = async (path: string) => (await api.get<Page<unknown>>(path)).total;
    const safe = (p: Promise<number>) => p.catch(() => null);
    (async () => {
      const [tenants, users, cams, live, rec, off] = await Promise.all([
        auth.can("tenants.read")
          ? safe(total("/tenants?pageSize=1&status=active"))
          : Promise.resolve(null),
        auth.can("users.read")
          ? safe(total("/users?pageSize=1&status=active"))
          : Promise.resolve(null),
        safe(total("/cameras?pageSize=1")),
        safe(total("/cameras?pageSize=1&status=ao_vivo")),
        safe(total("/cameras?pageSize=1&status=gravando")),
        safe(total("/cameras?pageSize=1&status=offline")),
      ]);
      const s: Stat[] = [];
      if (auth.isPlatform)
        s.push({
          label: "Clientes Ativos",
          value: tenants,
          icon: Building2,
          tone: "text-brand-600 bg-brand-50",
          href: "/clientes",
        });
      if (users !== null)
        s.push({
          label: "Usuários Ativos",
          value: users,
          icon: Users,
          tone: "text-violet-600 bg-violet-50",
          href: "/usuarios",
        });
      s.push({
        label: "Total de Câmeras",
        value: cams,
        icon: Camera,
        tone: "text-sky-600 bg-sky-50",
        href: "/cameras",
      });
      s.push({
        label: "Câmeras Online",
        value: live === null && rec === null ? null : (live ?? 0) + (rec ?? 0),
        icon: Wifi,
        tone: "text-green-600 bg-green-50",
        href: "/cameras?status=ao_vivo",
      });
      s.push({
        label: "Câmeras Offline",
        value: off,
        icon: CameraOff,
        tone: "text-red-600 bg-red-50",
        href: "/cameras?status=offline",
      });
      setStats(s);
    })();
  }, [auth]);

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={`Visão geral${auth.user?.tenant ? ` · ${auth.user.tenant.name}` : ""}`}
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {stats.map((s) => {
          const Icon = s.icon;
          const body = (
            <div className="card flex items-center gap-4 p-4 transition hover:shadow-md">
              <div className={`flex h-12 w-12 items-center justify-center rounded-xl ${s.tone}`}>
                <Icon size={24} />
              </div>
              <div>
                <div className="text-xs font-medium text-muted">{s.label}</div>
                <div className="text-2xl font-semibold">{s.value ?? "—"}</div>
              </div>
            </div>
          );
          return s.href ? (
            <Link key={s.label} href={s.href}>
              {body}
            </Link>
          ) : (
            <div key={s.label}>{body}</div>
          );
        })}
      </div>
      <Monitor />
    </>
  );
}
