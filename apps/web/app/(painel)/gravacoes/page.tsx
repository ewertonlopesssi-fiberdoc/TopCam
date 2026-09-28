import { Placeholder } from "@/components/placeholder";

export const metadata = { title: "Gravações" };

export default function Page() {
  return (
    <Placeholder
      title="Gravações"
      subtitle="Reprodução e linha do tempo"
      phase={5}
      items={[
        "Calendário e linha do tempo com as lacunas de sinal",
        "Reprodução com controle de velocidade",
        "Exportação em MP4 autorizada e registrada na auditoria",
        "A gravação contínua da CAM-001 com retenção de 24 h entra na Fase 4",
      ]}
    />
  );
}
