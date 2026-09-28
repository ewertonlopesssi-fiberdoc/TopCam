import { Placeholder } from "@/components/placeholder";

export const metadata = { title: "Ao Vivo" };

export default function Page() {
  return (
    <Placeholder
      title="Ao Vivo"
      subtitle="Visualização das câmeras em tempo real"
      phase={3}
      items={[
        "Mosaico 1, 4, 9 e 16 câmeras e tela cheia",
        "Árvore Cliente › Local › Grupo com o estado de cada câmera",
        "Vídeo por links temporários (a chave da câmera nunca chega ao navegador)",
        "Só as câmeras autorizadas para cada usuário",
      ]}
    />
  );
}
