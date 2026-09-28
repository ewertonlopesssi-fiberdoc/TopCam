import { Placeholder } from "@/components/placeholder";

export const metadata = { title: "Servidores" };

export default function Page() {
  return (
    <Placeholder
      title="Servidores"
      subtitle="Nós de ingestão e de gravação"
      phase={7}
      items={[
        "CPU, memória, disco e rede de cada servidor",
        "Streams recebidos por nó",
        "Estado e histórico de 7 dias",
      ]}
    />
  );
}
