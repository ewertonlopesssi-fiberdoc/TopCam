"use client";

import { Shell } from "@/components/shell";
import { Loading } from "@/components/ui";
import { useRequireAuth } from "@/lib/auth";

export default function PainelLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useRequireAuth();
  if (loading || !user || user.mustChangePassword) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loading label="Verificando sessão…" />
      </div>
    );
  }
  return <Shell>{children}</Shell>;
}
