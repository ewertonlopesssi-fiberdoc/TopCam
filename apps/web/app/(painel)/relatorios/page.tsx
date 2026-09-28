import { Placeholder } from "@/components/placeholder";

export const metadata = { title: "Relatórios" };

export default function Page() {
  return (
    <Placeholder
      title="Relatórios"
      subtitle="Disponibilidade, uso e acessos"
      phase={7}
      items={[
        "Disponibilidade por câmera e por cliente",
        "Uso de armazenamento e tráfego",
        "Acessos e exportações",
      ]}
    />
  );
}
