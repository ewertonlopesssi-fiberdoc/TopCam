import { Placeholder } from "@/components/placeholder";

export const metadata = { title: "Armazenamento" };

export default function Page() {
  return (
    <Placeholder
      title="Armazenamento"
      subtitle="Uso de disco, retenção e previsão de esgotamento"
      phase={6}
      items={[
        "Uso por cliente e por disco de vídeo",
        "Alertas em 70%, 85% e 95% e parada controlada da gravação",
        "Previsão de esgotamento a partir do consumo real",
      ]}
    />
  );
}
