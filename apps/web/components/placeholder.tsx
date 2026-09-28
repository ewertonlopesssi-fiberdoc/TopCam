import { Construction } from "lucide-react";
import { PageHeader } from "./ui";

/** Página de módulo ainda não implementado: informa em qual fase ele chega (nada é simulado). */
export function Placeholder({
  title,
  subtitle,
  phase,
  items,
}: {
  title: string;
  subtitle: string;
  phase: number;
  items: string[];
}) {
  return (
    <>
      <PageHeader title={title} subtitle={subtitle} />
      <div className="card flex flex-col items-center px-6 py-14 text-center">
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">
          <Construction size={28} />
        </div>
        <h2 className="text-lg font-semibold">Disponível na Fase {phase}</h2>
        <p className="mt-1 max-w-lg text-sm text-muted">
          Este módulo faz parte do plano e será entregue nessa fase, com testes próprios. O que ele
          vai trazer:
        </p>
        <ul className="mt-4 max-w-lg space-y-1 text-left text-sm text-slate-700">
          {items.map((i) => (
            <li key={i} className="flex gap-2">
              <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />
              {i}
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
