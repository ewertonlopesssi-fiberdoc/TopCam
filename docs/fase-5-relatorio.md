# TopCam — Relatório da Fase 5 (gravações: reprodução e linha do tempo)

29/09/2026, no ambiente de desenvolvimento, com gravação real do transmissor de teste:

- **aceite: 8/8 critérios aprovados**;
- **112 testes automatizados** aprovados;
- **E2E da tela Gravações** aprovado no Google Chrome.

Ainda falta rodar na VM de laboratório e conferir com a TWG 6608 (procedimento no fim).

## O que foi entregue

| Área | Entrega |
|---|---|
| Tela Gravações | Árvore Empresa › Local › Grupo com as câmeras que gravam (a mesma do Ao Vivo, agora num componente comum), player, linha do tempo, calendário e resumo do dia. Funciona no computador, tablet e celular |
| Calendário | Mês em português, com os dias que têm gravação em destaque e o dia de hoje marcado. Clicar num dia abre a linha do tempo dele. Abre no dia da gravação mais recente |
| Linha do tempo | Dia inteiro com zoom de 24 h, 6 h ou 1 h, e setas para andar. Mostra os trechos gravados (azul), as **lacunas de sinal** (vermelho, com duração e horário ao passar o mouse) e o cursor da reprodução. Clique para ir ao ponto; ←/→ andam 1 min. O dia de hoje atualiza a cada minuto |
| Player | Toca os trechos em sequência e **pula as lacunas sozinho**. Velocidades 0,5x, 1x, 2x, 4x e 8x; ±10 s; pausa; som; tela cheia. Mostra a data e a hora do quadro exibido |
| Buscar | Os campos **Início** e **Fim** (horário de Brasília) servem para ir direto a um horário (**Buscar**) e para escolher o trecho da exportação |
| Exportação MP4 | Botão **Baixar MP4**, só para quem tem **pode exportar** na câmera. Gera o trecho Início–Fim (máximo 1 h, ajustável em `EXPORT_MAX_S`) com o nome `CAM-001_AAAA-MM-DD_hh-mm-ss_Nmin.mp4`. Se o trecho tiver lacunas, os blocos gravados vêm emendados num arquivo só. O link vale 10 min e fica preso ao usuário e à sessão |
| Auditoria | "Gravação assistida" (um registro por usuário e câmera a cada 30 min), "Exportação de vídeo solicitada" (trecho, segundos pedidos e gravados) e "Vídeo exportado" (no download) |
| Segurança | O navegador recebe só `/playback/<token>/get?…`. O token é assinado, vale 2 h e é ligado ao usuário, à sessão e à câmera. O gateway reconfere a permissão **pode reproduzir** a cada pedido; tokens de ao vivo e de gravação não servem um para o outro. Só `/get` em fMP4 de até 1 h é aceito. O servidor de reprodução (porta 9996) fica só na rede interna e exige credencial |
| API | `GET /cameras/:id/recordings/days` (calendário), `POST /cameras/:id/playback` (endereço temporário), `POST /cameras/:id/exports` e `GET /exports/:token` (download). O resumo da câmera agora informa o nome e se o usuário pode exportar |

## Resultado do aceite

Evidência: `docs/evidencias/aceite-fase5-20260929.md` e o log dos testes. No aceite, a CAM-001 da Empresa Alfa (de teste) gravou com o transmissor de teste e caiu por 30 s para criar uma lacuna.

| # | Critério | Resultado |
|---|---|---|
| G1 | Servidor de reprodução ligado e só na rede interna | ✅ porta 9996 não publicada |
| G2 | Calendário com o dia gravado; lacuna da queda na linha do tempo | ✅ lacuna de 35,2 s |
| G3 | Reprodução pelo gateway | ✅ fMP4 válido, 30,1 s para 30 s pedidos, `no-store`, sem cookie |
| G4 | Reprodução recusada nos casos indevidos | ✅ sem token, adulterado, outra câmera, token do ao vivo e `/list` → 403; mais de 1 h e formato errado → 400; direto no servidor → 401 |
| G5 | Permissão do visualizador | ✅ só ao vivo → 404; com "pode reproduzir" → 200; outra câmera → 404; retirar a permissão corta o endereço já emitido → 403 |
| G6 | Exportação MP4 | ✅ sem permissão 403; acima do máximo e no futuro 400; sem gravação 404; MP4 válido de 120,0 s (h264+aac); link adulterado 403; auditoria |
| G7 | Exportação atravessando a lacuna | ✅ 120 s gravados em 155 s pedidos → arquivo de 120,9 s |
| G8 | Lint e testes | ✅ 112/112 |

### Tela (E2E, Google Chrome, 1440 px)

O teste lê o relógio que o transmissor desenha em cada quadro e compara com o horário mostrado pelo player:

| Verificação | Resultado |
|---|---|
| Precisão do horário ao reproduzir | diferença mediana de **~0,1 s** (pior amostra 0,25 s) |
| Buscar (4 min atrás) | chegou ao horário pedido, com a mesma precisão |
| Salto de lacuna | lacuna de 35,1 s: o player foi de 03:32:07,7 para 03:32:42,9 sozinho |
| Velocidade 4x | medida **4,07x** |
| Exportação de 1 min pela tela | arquivo `CAM-001_…_1min.mp4`, 60,0 s, h264+aac; auditoria com pedido e download |
| Visualizador | sem "pode reproduzir" vê o aviso; com ela reproduz e o botão Baixar MP4 não aparece; exportação pela API → 403 |
| Layout | computador, tablet e celular sem rolagem horizontal (`reports/screens/gravacoes-*.png`) |

### Primeira execução na VM (29/09, 06:50)

Duas execuções do aceite rodaram ao mesmo tempo, iniciadas às 06:50:03 e às 06:51:18, e uma atrapalhou a outra:

- a segunda reiniciou o transmissor da CAM-001 no meio da primeira;
- as duas baterias de testes disputaram o mesmo papel do banco.

Resultados: **6/8** e **7/8**.

- **G1–G5 e G7 passaram nas duas.**
- **G6:** o arquivo de 115 s (para 120 s pedidos) estava certo. O trecho continha o buraco de 5 s criado pela outra execução, e a API emendou os 2 blocos (auditoria: `parts: 2`, `recorded_seconds: 115`).
- **G8:** `tuple concurrently updated` ao alterar o papel `topcam_app`, que é único no servidor.

Correções:

1. **Trava contra execução dupla** (`flock`) nos aceites das Fases 3, 4 e 5: um segundo aceite recusa rodar (saída 3).
2. **G6** confere a duração do arquivo contra o tempo **gravado** no trecho, e o trecho termina dentro de um bloco já conferido.
3. **Testes:** a criação e a alteração do papel `topcam_app` ficam atrás de uma trava do Postgres.

Conferido no ambiente de desenvolvimento:

- duas baterias simultâneas: nenhuma disputa do papel. Sobraram 3 falhas de contadores de login no Redis compartilhado, que só existem com duas baterias juntas, e a trava impede isso;
- uma bateria: 112/112;
- aceite: 8/8.

### Aceite na VM (29/09, 08:16): **8/8**, 112/112 testes

Rodado uma vez só, com a trava contra execução dupla. G6: MP4 de 120,0 s, com 122 s gravados. G7: 120 s gravados de 200 s pedidos, arquivo de 120,7 s. Push `ae84387`.

### Investigação: lacunas da TWG e travadas de disco no host

Na VM apareceram de 1 a 5 lacunas de 3 a 10 s por hora na TWG, sem queda de conexão. O servidor de mídia registrava `reader is too slow, discarding N frames` seguido de `too many reordered frames`.

| Onde | Evidência |
|---|---|
| VM | Pressão de IO `full avg300` de 9,8%; `w_await` médio desde o boot de 569 ms (sistema) e 206 ms (vídeo), com o normal abaixo de 3 ms; ffprobe estourando 30 s; `docker rm` levando 70 s |
| Host Proxmox | IO delay com picos de 30 a 45%, junto com o pico de escrita da VM 101 (CDNTV-EDGE, 3 a 10 MB/s contínuos) |
| Armazenamento | `local-lvm` em 2× **Kingston A400 480 GB**: SSD de entrada, sem DRAM, atrás da PERC H700, sem TRIM. É compartilhado pelo TopCam e pela CDNTV-EDGE |

**Causa:** a escrita contínua da CDN satura os A400, e todas as VMs do `local-lvm` travam. O EDGE também sofre, e há relatos de travamento no conteúdo dele.

**Providências:**

1. **Suporte do EDGE:** vai aumentar o cache em memória para reduzir a escrita em disco.
2. **Recomendado:** trocar os A400 por SSDs de datacenter.
3. **Atenção:** o `HD18-TB` (1× WD Purple 18 TB, disco único) está 99% cheio.

**Proteção no TopCam (aprovada):** `writeQueueSize: 8192` no servidor de mídia. Teste aqui, com o disco de gravação congelado por 45 s (`fsfreeze`):

| Fila | Quadros descartados | Vídeo no segmento da travada |
|---|---|---|
| 512 (padrão) | ~130 por segundo, depois de ~8 s | **buraco de 40,7 s dentro do segmento**, que o índice não vê (441 de ~1.050 quadros) |
| **8192** | **nenhum** | 900 quadros por 60 s, sem buraco; memória do servidor de mídia ~52 MB |

A fila de 8192 aguenta ~6 min numa câmera de 15 fps com AAC 8 kHz.

**Observação:** com a fila pequena, o buraco pode ficar **dentro** do segmento, sem aparecer como lacuna. Então a perda real na VM pode ter sido maior que as lacunas registradas. A Fase 6 passa a detectar buracos internos na conferência dos segmentos.

**Ajustes de diagnóstico (aprovados):**
- o worker registra `ffprobe: tempo esgotado (30 s) — disco lento ou travado?` (teste novo; 113/113);
- o aceite marca a queda só depois que o transmissor cai de fato.

## Problemas encontrados e corrigidos durante a fase

1. **O servidor de reprodução para na primeira lacuna.** Uma exportação de 150 s com uma queda no meio devolvia só os 60 s antes da queda, sem nenhum aviso.
   - **Solução:** a API divide o trecho em blocos contínuos e pede um por um. Com mais de um bloco, o ffmpeg emenda tudo sem recodificar e entrega o arquivo em fluxo, sem gravar nada em disco. Resultado: 116,4 s para 115 s gravados.
2. **Pedir exatamente o início de um bloco dava 404.** O banco guarda o início do segmento em milissegundos, mas o arquivo começa até 1 ms depois.
   - **Solução:** a API e o player pedem 5 ms depois do início do bloco.
3. **O player perderia vídeo em interrupções curtas.** Intervalos de 1 a 3 s não entram como lacuna na linha do tempo, mas o servidor para neles.
   - **Solução:** o player trata como bloco só o que está a até 1 s de distância (a mesma tolerância do servidor). Se o vídeo terminar antes do previsto, ele segue para o próximo bloco em vez de pular o resto.
4. **Links de exportação longos recusados (414).**
   - **Solução:** limite de parâmetro da API aumentado para 1000 caracteres.

## Mudanças em relação ao plano

| Plano | Implementado | Motivo |
|---|---|---|
| Player com seletor livre de posição | Player em trechos de até 15 min. Ir para um ponto carrega um trecho novo a partir dele | O servidor de reprodução não aceita pedidos parciais (Range); assim a busca é imediata e a precisão fica em ~0,1 s |
| Exportação do trecho | Arquivo com os blocos gravados emendados (as lacunas não viram tela preta) | É o que o servidor entrega; o nome do arquivo e a auditoria registram o início, o trecho pedido e o total gravado |
| — | Aviso "Sem permissão para gravações" para quem tem só o ao vivo | Deixa claro que falta a permissão, em vez de uma tela vazia |

## O que NÃO foi testado aqui (e como validar)

| Item | Situação | Como validar |
|---|---|---|
| VM Debian no Proxmox | Pendente | `scripts/accept-phase5.sh` (abaixo), ~10 min, deve dar 8/8 |
| TWG 6608 na tela Gravações | Sem a câmera aqui | Abrir **Gravações**, escolher a TWG, conferir calendário e lacunas, tocar em 1x e 4x e baixar 1 min em MP4 |
| E2E na VM | A VM não tem navegador | A conferência na tela acima substitui; o E2E pode rodar de outra máquina com o Chrome (README) |
| Rede lenta ou celular (4G) | Não medido | Com 1,9 Mbps, 8x precisa de ~15 Mbps. Em rede fraca use 1x a 2x |

## Pendências e observações

- **Fase 4:** continua pendente a prova de **24 h reais** de retenção (`recording:status` hoje depois das 23:05).
- **Tempo de exportação:** 1 h da TWG (~850 MB) leva o tempo do download na sua rede. O servidor não guarda cópia.
- **Horário:** a tela e o nome do arquivo usam o horário de Brasília (America/Sao_Paulo). Clientes em outro fuso ficam para quando houver a configuração por cliente.

## Atualizar a VM e validar

```bash
cd /opt/topcam
nohup scripts/update.sh --bundle /root/topcam-fase5.bundle > /root/update5.log 2>&1 &
tail -f /root/update5.log                               # até "tudo saudável"
nohup scripts/accept-phase5.sh --no-build > /root/aceite5.log 2>&1 &   # rode UMA vez só
tail -f /root/aceite5.log                               # ~10 min; deve dar 8/8
git push
```

O aceite usa só a CAM-001 da Empresa Alfa (de teste). A TWG 6608 continua gravando sem interrupção.

## Próxima fase (6): armazenamento e proteção de disco

- Cota do disco de vídeo e alertas em 70, 85 e 95%.
- Parada controlada da gravação com o disco cheio, e retomada automática.
- Telas Armazenamento e Servidores.
