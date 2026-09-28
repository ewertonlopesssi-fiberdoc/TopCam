import { Placeholder } from "@/components/placeholder";

export const metadata = { title: "Eventos e Alertas" };

export default function Page() {
  return (
    <Placeholder
      title="Eventos e Alertas"
      subtitle="Quedas, recusas de chave, falhas de gravação e disco"
      phase={7}
      items={[
        "Lista de eventos por câmera e por cliente (já registrados desde a Fase 1)",
        "Alertas abertos, reconhecidos e resolvidos",
        "Avisos por e-mail",
      ]}
    />
  );
}
