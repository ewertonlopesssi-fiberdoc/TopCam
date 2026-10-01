# Fase 9.2: app mobile, gravações, mosaico, alarmes e vídeos (01/10/2026)

**Situação**

- Pronto e testado no laboratório.
- **APK 0.2.0** gerado, apontando para a produção.
- A parte do **servidor** (foto das câmeras e lista de alarmes) só entra na produção **depois do relatório de 7 dias**, a partir de 08/10, 14:52. Até lá, o app novo funciona na produção sem essas duas coisas: a lista mostra o ícone em vez da foto, e Alarmes avisa que chega na próxima atualização.

**Resultado do teste da 9.1 no celular, feito pelo Ewe**

- O ao vivo funcionou, inclusive o mosaico com 4 câmeras TWG tocando.
- Apareceu um defeito: o seletor de páginas do mosaico ficava atrás da barra do Android. **Corrigido.**

## Pedidos do Ewe (inspirados no outro app)

| Pedido | Entrega |
|---|---|
| Última imagem de cada câmera na lista | Foto da câmera na lista, tirada pelo servidor a cada 5 min. O celular guarda a última que baixou e mostra enquanto a nova carrega, ou sem internet |
| Mosaico de mais câmeras | **1, 4 e 9** ao vivo (o Ewe pediu até 9 para testar), por grupo ou todas, com páginas |
| Tocar na câmera do mosaico e ela ficar grande | Amplia ali mesmo, com "Voltar ao mosaico", som, tela cheia e Gravações. As outras param enquanto isso |
| Menu de vídeos salvos e alarmes | Abas **Alarmes** e **Meus vídeos** |
| Rever gravações, adiantar, arrastar e baixar | Tela **Gravações**: calendário, linha do tempo para arrastar (zoom de 24 h, 6 h e 1 h) com movimento em âmbar, voltar e avançar 10 s e 30 s, velocidades de 1x a 16x, som, tela cheia e **Baixar trecho** (1 a 60 min a partir do horário escolhido) |

Ficou para depois, por decisão do Ewe: **mosaicos salvos com nome** e o mosaico de **16**.

## Como funciona

- **Menu de baixo:** Câmeras · Mosaico · Alarmes · Meus vídeos · Conta.
- **Câmeras:**
  - cartões com a foto, o nome, o código e o status;
  - pesquisa a partir de 5 câmeras;
  - botão "Mosaico" em cada grupo.
- **Mosaico:**
  - os vídeos só tocam com a aba aberta;
  - ao trocar de aba ou abrir outra tela por cima, param, para não gastar dados nem bateria;
  - o ao vivo de uma câmera também para quando as gravações dela são abertas por cima.
- **Gravações:**
  - abre pelo ao vivo (botão "Gravações", só para quem pode reproduzir e só se a câmera grava), pelo mosaico ampliado ou por um alarme;
  - pelo alarme, abre 10 s antes do movimento;
  - usa o mesmo servidor de reprodução do painel, com as mesmas permissões e auditoria.
- **Baixar trecho:**
  - usa a mesma exportação MP4 do painel ("pode exportar", até 60 min, registrada na auditoria);
  - o arquivo fica em **Meus vídeos**, onde dá para assistir, compartilhar, salvar na galeria e apagar;
  - o vídeo fica só no celular, e apagar não mexe na gravação do servidor.
- **Alarmes:**
  - os movimentos das câmeras que o usuário vê, com a foto, o tipo (pessoa, movimento ou som), a câmera, o local e o horário;
  - tocar abre a gravação no horário, ou o ao vivo se o usuário não pode reproduzir;
  - a notificação push continua na 9.3.

## Servidor (entra depois de 08/10)

| Item | Detalhe |
|---|---|
| Foto das câmeras | O serviço `motion` tira 1 quadro-chave de cada câmera no ar a cada 5 min (480 px, JPEG), no máximo 2 ao mesmo tempo. Fica em `.data/snapshots`. Fotos de câmeras excluídas são apagadas de hora em hora |
| `GET /api/v1/cameras/:id/snapshot` | Entrega a foto só a quem vê a câmera, com `X-Snapshot-At` (horário da foto). Sem foto, 404 |
| `GET /api/v1/motion-events` | Alarmes, por página, mais recentes primeiro. Operador e visualizador veem só as câmeras liberadas; `canPlayback` diz se podem abrir a gravação |
| `compose.yaml` | Pasta `.data/snapshots`: o `motion` escreve, a API só lê, e o `storage-init` cria a pasta |

O servidor de mídia, a gravação e o banco não mudam (não há migration nova).

## Testes

| Teste | Resultado |
|---|---|
| Suíte completa | **267/267** (eram 262). Novos: foto (404 sem foto, entrega só a quem vê a câmera), alarmes por usuário, geração da foto com ffmpeg real (480×270, renova depois de 5 min, limpeza) e datas e trechos de reprodução do app |
| E2E do app 9.2 (versão web, celular, laboratório) | **1/1** (o teste da 9.1 continua passando). Cobre: |
| | • 5 câmeras transmitindo, todas com a foto na lista |
| | • mosaico: 4 por página (2 páginas), 9 numa só, 1 por página |
| | • ampliar e voltar; vídeos param fora da aba |
| | • alarme "Pessoa detectada" → abre a gravação |
| | • linha do tempo com o movimento |
| | • reprodução respondendo 200 com `video/mp4` |
| | • velocidade 8x aplicada ao player; calendário com o dia gravado |
| | • câmera sem "pode reproduzir" não mostra Gravações |
| Lint e tipagem (projeto e app) | Sem erros |
| APK | `br.com.suportinet.topcam` **0.2.0** (versionCode 2), arm64-v8a, 48 MB |

Capturas em `reports/screens/`: `app92-cameras.png`, `app92-mosaico9.png`, `app92-ampliada.png`, `app92-alarmes.png`, `app92-gravacoes.png`.

## O que NÃO foi testado (e como validar)

| Item | Como validar |
|---|---|
| 9 vídeos ao vivo ao mesmo tempo no celular | Mosaico → 9, de preferência com 9 câmeras no ar. Observe se trava ou esquenta e se dá para usar no 4G |
| Reprodução, velocidade e arrastar no celular | Abra as Gravações da TWG e confira: tocar, 4x/8x/16x, arrastar a linha do tempo, voltar e avançar |
| Baixar trecho e salvar na galeria | Baixe 1 min e abra em Meus vídeos; teste compartilhar e "Salvar na galeria" |
| Foto e Alarmes na produção | Depois da atualização do servidor (08/10) |
| iPhone | Precisa da conta Apple Developer |

## Arquivos

**App**

- `src/app/(tabs)/`: `index.tsx` (lista com foto), `mosaico.tsx`, `alarmes.tsx`, `videos.tsx` e `_layout.tsx`.
- `src/app/gravacoes/[id].tsx`, `src/app/video/[file].tsx` e `src/app/camera/[id].tsx` (botão Gravações; para quando sai de foco).
- `src/components/`: `camera-thumb.tsx`, `timeline.tsx`, `month-calendar.tsx`.
- `src/lib/`: `time.ts`, `videos.ts`, `local-json.ts`, `use-cameras.ts`; `api.ts` (cabeçalho para imagens).
- `app.config.ts`: permissão da galeria; versão 0.2.0.
- Pacotes novos: `expo-image`, `expo-file-system`, `expo-sharing`, `expo-media-library`.

**Servidor**

- `apps/worker/src/motion/snapshots.ts` (novo) e `apps/worker/src/motion-main.ts`.
- `apps/api/src/routes/cameras.ts` (foto), `apps/api/src/routes/motion.ts` (novo), `apps/api/src/app.ts` e `apps/api/src/env.ts`.
- `compose.yaml`.

**Testes**

- `apps/api/test/motion.int.test.ts`, `apps/worker/test/motion.int.test.ts`, `apps/mobile/test/app.unit.test.ts`.
- `e2e/app-mobile-92.spec.ts`.
