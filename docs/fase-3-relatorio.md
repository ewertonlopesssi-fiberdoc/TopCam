# TopCam — Relatório da Fase 3 (ao vivo)

28/09/2026 · resultados no ambiente de desenvolvimento:

- **aceite: 10/10 critérios aprovados**;
- **E2E: 12/12**, incluindo os 2 testes novos do ao vivo, com as 5 câmeras transmitindo;
- **85 testes automatizados**.

**Na VM de laboratório (28/09/2026, commit `8bfa7b0`): aceite 10/10**, com os 85 testes aprovados.

A **câmera TWG 6608 foi validada** com a câmera real (dúvida D1 fechada; detalhes abaixo).

## Ajustes aprovados junto com a fase

| Ajuste | Entrega |
|---|---|
| Dashboard | Os cartões contam só **clientes ativos** e **usuários ativos**. Cancelados e desativados continuam nas telas Clientes e Usuários (filtro de status) |
| Exclusão de usuário | Botão **Excluir** em Usuários, comando `user:delete` na CLI e `DELETE /api/v1/users/:id`. A exclusão é lógica: o usuário sai das listas, perde as sessões e as permissões, o e-mail fica livre para novo cadastro e o registro continua na auditoria. O aceite da Fase 2 passou a excluir os usuários que cria |
| Atualização | `scripts/update.sh` faz `git pull` (ou `--bundle`), `--add-missing` no `.env`, build/subida e recriação do gateway e do MediaMTX quando a configuração deles muda. Depois espera todos ficarem saudáveis e recusa atualizar com alterações locais. O gateway monta a pasta `infra/caddy` e roda com `--watch`: o Caddy recarrega sozinho quando o Caddyfile muda (confirmado nos logs) |
| Bloqueio de `/internal` | O `respond 404` das rotas internas rodava depois dos `handle` (ordem de diretivas do Caddy). Na Fase 2, o 404 vinha do painel, não do gateway. Agora é um `handle` próprio, avaliado primeiro |

## O que foi entregue

| Área | Entrega |
|---|---|
| Endereço temporário | `POST /api/v1/live/sessions` (até 16 câmeras, para o mosaico) e `POST /api/v1/cameras/:id/live`. Cada câmera recebe `/live/<token>/index.m3u8` (HLS) e `/live/<token>/whep` (WebRTC). O token, `v1.<dados>.<HMAC>`, vale 2 h e fica ligado ao usuário, à sessão e à câmera. **Não contém a chave RTMP nem o caminho interno** |
| Gateway | `/live/*` passa por `forward_auth` na API. A API confere a assinatura e a validade e, com cache de 5 s, também sessão, usuário, clientes, câmera e permissão "ao vivo". Só então o gateway troca o caminho por `cam/<id>` e encaminha ao MediaMTX com o token próprio dele. Aceita só os recursos de HLS (`*.m3u8`, `*.mp4`) e WHEP, e só os métodos de cada um. Esses endereços não vão para o log de acesso (o token é uma credencial) |
| Servidor de mídia | LL-HLS (partes de 200 ms) e WebRTC (WHEP) ligados. HLS, sinalização WebRTC, API e RTSP continuam só na rede interna. A mídia WebRTC sai pela porta **8189 UDP/TCP**, anunciada em `PUBLIC_HOST`. O token do gateway **só lê `cam/<id>` por HLS/WebRTC**: não lê a entrada `live/<chave>`, não publica e não usa RTSP |
| Revogação no WebRTC | No HLS, cada pedido passa pelo gateway. No WebRTC, só a negociação passa, e a mídia vai direto do servidor de mídia ao navegador. Por isso, a cada 10 s o worker confere as conexões WebRTC abertas (pelo token que a oferta leva) e encerra as que perderam o acesso: logout, usuário ou cliente desativado, permissão ou câmera retirada |
| Tela Ao Vivo | Mesmo layout da imagem de referência: barra com cliente, local, mosaico **1/4/9/16**, **Tela Cheia**, grupo e modo de transmissão. Árvore **Empresa › Local › Grupo** com o estado de cada câmera. Cada vídeo tem título `CAM-001 - Nome`, selo **AO VIVO**, pausa (volta ao ponto ao vivo), som, captura de imagem (PNG) e tela cheia. Também há foco numa câmera (duplo clique ou clique na árvore), paginação quando há mais câmeras que o mosaico e avisos de compatibilidade (H.265, áudio G.711). "Automático" tenta **WebRTC** e, se não conectar em 8 s, usa **HLS**. Quando algo falha, pede um endereço novo e tenta de novo sozinho. Os estados são atualizados a cada 10 s. No tablet e no celular, a árvore vira gaveta ("Câmeras") e o mosaico usa no máximo 3 ou 2 colunas |
| Câmeras | Ícone **Ao vivo** na lista abre a câmera em foco (`/ao-vivo?camera=<id>`) |
| Auditoria | `camera.live_viewed`: um registro por usuário e câmera a cada 30 min |
| Transmissor de teste | `TX_CLOCK=1` desenha no vídeo uma faixa com o relógio em milissegundos. O E2E lê essa faixa na tela para medir a latência de ponta a ponta |
| Testes | Novos: 10 de integração (token, gateway, revogação, leitura no servidor de mídia), 1 do worker (guarda do WebRTC), 1 de exclusão de usuário e 2 E2E com vídeo real. Também o aceite `scripts/accept-phase3.sh` |

## Resultado do aceite

Evidências:

- `docs/evidencias/aceite-fase3-20260928.md` e o log dos testes;
- capturas e medições em `docs/evidencias/fase3/`.

| # | Critério | Resultado |
|---|---|---|
| L1 | 5 câmeras recebidas por RTMP e ao vivo | ✅ em 7 s |
| L2 | Endereços para as 5, sem chave nem caminho interno | ✅ 0 vazamentos |
| L3 | As 5 tocam por HLS pelo gateway (conferido com ffprobe) | ✅ H.264 640x360 |
| L4 | WHEP pelo gateway, mídia anunciada em `PUBLIC_HOST:8189` | ✅ |
| L5 | Token adulterado ou vencido → 403; `/cam/` direto → 404; visualizador só vê a câmera liberada; logout corta o vídeo | ✅ |
| L6 | Ao vivo não grava | ✅ 0 arquivos, 0 segmentos |
| L7 | Atraso do HLS na borda do servidor (informativo) | ✅ 0,08 s |
| L8 | Portas internas fechadas; 8189/UDP publicada | ✅ |
| L9 | Consumo com as 5 câmeras recebidas e assistidas (informativo) | ✅ MediaMTX ~9% de CPU, 53 MB |
| L10 | Lint e testes | ✅ 85/85 |

| E2E (Google Chrome, 1440 px) | Resultado |
|---|---|
| Mosaico com 4 câmeras tocando em WebRTC; mosaico de 9 com as 5; HLS; foco e volta | ✅ |
| Nenhum endereço ou resposta com chave ou caminho interno; endereço adulterado → 403 | ✅ |
| **Latência de ponta a ponta** (mediana de 12 leituras) | **WebRTC 0,09 s · HLS 1,6 s** |
| Visualizador vê só a câmera liberada | ✅ |
| Permissão retirada: o painel para o vídeo | ✅ em 5 s |
| Permissão retirada: uma conexão WebRTC aberta "por fora" do painel é derrubada pelo worker | ✅ em 10 s |
| Telas em 1440, 768 e 390 px com vídeo, sem rolagem horizontal | ✅ |

**A latência foi medida no laboratório:** transmissor, servidor e navegador rodaram na mesma máquina, sem rede entre eles. Com a câmera real e a rede de vocês, some a latência do codificador da câmera e da rede. Isso se mede com o cronômetro (procedimento abaixo).

## Validação da câmera TWG 6608 (D1 fechada)

| Item | Resultado |
|---|---|
| Envio | **RTMP push** com campo único de URL (Rede › Serviço de rede): basta marcar Habilitar e colar a **URL completa** do cadastro (`rtmp://172.31.141.20:1935/live/<chave>`) |
| Codificação usada (MainStream) | H.264, 1080p (1920x1080), 15 fps, **CBR 1.755 kbps**, I Frame Interval 2, áudio **AAC** 8 kHz. A câmera também oferece H.265/H.265+ e 720p |
| Recebido pelo TopCam | H264 1920x1080 @ 15 fps, áudio aac, **1,9 Mbps** medidos, status Online |
| Espaço estimado em 24 h | ~20,5 GB (≈59% do disco de vídeo de 35 GB, abaixo do alerta de 70%) |
| Ao vivo | Toca em **WebRTC** e em **HLS** no painel |
| Latência | Na virada do minuto, sem diferença visível em segundos para o cronômetro, nos dois modos: **abaixo de cerca de 1 s** |
| Áudio | AAC toca no HLS. No WebRTC o vídeo chega sem som, porque o WebRTC do navegador não aceita AAC |
| Cadastro | Condomínio Sol › Bloco A › Portaria, **CAM-001 "Portão Social"**, com gravação contínua de 24 h. É a câmera gravada da Fase 4. A gravação da CAM-001 da Empresa Alfa (teste) foi desmarcada pelo Ewe |

## Problemas encontrados e corrigidos durante a fase

1. **Ordem das diretivas do Caddy.** Sem um bloco `route`, o `rewrite` rodava antes do `forward_auth`.
   - **Solução:** agrupar a sequência em `route`.
2. **Sessão HLS do MediaMTX 1.21.** Ele redireciona para `?cookieCheck=1` e depois usa um cookie `Secure`, que o navegador descarta em HTTP.
   - **Solução:** o endereço já sai com `cookieCheck=1`, e a sessão HLS passa a ir na query dos endereços seguintes. O gateway não repassa cookies do servidor de mídia.
3. **Query montada por marcador no Caddy.** A query vinda de um cabeçalho era escapada como nome de parâmetro.
   - **Solução:** manter a query original (`{query}`) e passar só o caminho no cabeçalho.
4. **Revogação no WebRTC.** A mídia não passa pelo gateway depois da negociação.
   - **Solução:** o worker encerra as conexões cujo acesso foi retirado, identificadas pelo token que a oferta WHEP leva (`?t=`).
5. **Latência falsa no WebRTC.** O primeiro indicador usava o atraso do buffer do navegador, que não é latência de ponta a ponta.
   - **Solução:** a medição oficial passou a ser o relógio desenhado no vídeo.

## Mudanças em relação ao plano

| Plano | Implementado | Motivo |
|---|---|---|
| Token no caminho, validado pelo gateway | Igual. No WebRTC, a revogação também é feita pelo worker | A mídia WebRTC não passa pelo gateway |
| HLS (+ WebRTC) | WebRTC por padrão ("Automático"), HLS como reserva e opção manual | Menor atraso; o HLS cobre redes que bloqueiam a porta 8189 |
| — | Nova porta publicada: **8189 UDP/TCP** | Necessária para a mídia WebRTC |
| — | Variável nova: `MEDIA_GATEWAY_TOKEN` (`--add-missing`) | Credencial própria do gateway, separada da leitura interna do worker |

## O que NÃO foi testado aqui (e como validar)

| Item | Situação | Como validar |
|---|---|---|
| VM Debian no Proxmox | ✅ **10/10 em 28/09/2026** (PUBLIC_HOST 172.31.141.20). WebRTC anunciado em 172.31.141.20:8189; borda do HLS a 0,19 s; MediaMTX a ~31% de CPU (1 núcleo) recebendo 5 câmeras de teste mais a TWG 6608 em 1080p | — |
| WebRTC entre o computador e a VM | ✅ Painel em `http://172.31.141.20`: a TWG 6608 tocou em **WebRTC** e, trocando o modo, em **HLS** | — |
| Navegadores | Só Google Chrome (headless). O Chromium do Playwright não tem H.264 | Chrome, Edge, Firefox e celular (Android e iPhone) |
| TWG 6608 e latência real | ✅ Validada (ver seção abaixo). A latência foi comparada com um cronômetro só na resolução de segundos | Opcional: um print com os milésimos dá o número exato |
| Muitos espectadores ao mesmo tempo | Medido só com 1 navegador e 5 câmeras | Fica para o teste de capacidade (Fase 10) |

## Pendências e observações

- **HTTP no laboratório:** o WebRTC funciona em HTTP porque o navegador não pede microfone nem câmera. Com o domínio e o HTTPS (Fase 8), nada muda para o usuário.
- **Endereço de 2 h:**
  - No HLS, o player renova sozinho 1 min antes de vencer.
  - No WebRTC, a conexão aberta continua enquanto o acesso valer.
- **Cache de 5 s no gateway:** uma revogação leva até 5 s para valer no HLS e até cerca de 15 s no WebRTC (10 s do worker + detecção da queda).
- **Árvore do Ao Vivo:** a equipe da plataforma vê todos os clientes ativos, e as câmeras são carregadas só do cliente aberto. Isso prepara a escala do servidor dedicado.

## Atualizar a VM e validar

```bash
cd /opt/topcam
git pull /root/topcam-fase3.bundle main   # traz também o scripts/update.sh
scripts/update.sh --no-pull               # .env (MEDIA_GATEWAY_TOKEN, WEBRTC_BIND), build, recriação e saúde
scripts/accept-phase3.sh --keep-tx        # ~3 min, deve dar 10/10; deixa as 5 câmeras de teste no ar
git push
```

Depois, abra `http://172.31.141.20` → **Ao Vivo** → Empresa Alfa. Confira as 5 câmeras em WebRTC (rodapé do vídeo) e troque para HLS. Para parar os transmissores: `docker rm -f topcam-tx3-CAM-001 … topcam-tx3-CAM-005`.

Nas próximas atualizações basta `scripts/update.sh --bundle /root/<arquivo>.bundle`.

## Próxima fase (4): gravação e retenção

- Gravação contínua só da CAM-001.
- Verificação e indexação de cada segmento.
- Estado "gravando" só depois do primeiro segmento durável.
- Lacunas com evento.
- Retenção de 24 h e expurgo comprovado.
- Nenhum arquivo ou registro das CAM-002..005.
