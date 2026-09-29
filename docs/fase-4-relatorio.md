# TopCam — Relatório da Fase 4 (gravação e retenção)

28/09/2026 · no ambiente de desenvolvimento:

- **aceite: 10/10 critérios aprovados**, com transmissões reais do transmissor de teste;
- **104 testes automatizados** aprovados.

Ainda falta validar na VM de laboratório e deixar a TWG 6608 gravando 24 h (procedimento no fim).

## O que foi entregue

| Área | Entrega |
|---|---|
| Quem grava | Só as câmeras com **gravação** marcada no cadastro, e só com a **chave geral** ligada. A chave fica em Configurações e foi ligada pela migration `0004`. As câmeras só ao vivo continuam sem nenhuma gravação |
| Segmentos | O servidor de mídia grava o relay interno da câmera em **fMP4 de 60 s**, com partes de 1 s (numa queda, perde-se no máximo cerca de 1 s). O arquivo fica em `cam/<id da câmera>/<início UTC>.mp4`: a chave RTMP nunca aparece no nome |
| Índice | A cada início e fim de segmento, o servidor de mídia avisa a API, que registra o segmento no banco (`recording_segments`) com validade = início + retenção da câmera. O caminho gravado no banco é relativo, então muda só a pasta num servidor novo |
| Conferência | O worker confere cada segmento: o arquivo existe, tem tamanho, SHA-256 e mídia válida (ffprobe, com vídeo). Só então o segmento vale e a câmera passa a **Gravando**. Arquivo ilegível vira `corrupt` e arquivo ausente vira `missing`, os dois com evento |
| Lacunas | Intervalo maior que 3 s entre segmentos vira evento **recording_gap**, com início, fim e duração (um por par de segmentos). É a base da linha do tempo da Fase 5 |
| Varredura | A cada minuto o worker percorre a pasta de gravações e resolve o que os avisos não trouxeram (reinício do servidor de mídia, API fora do ar): registra arquivos que faltam no banco e manda conferir os parados há 90 s. Também marca `missing` o que sumiu do disco e alerta se aparecer gravação de câmera só ao vivo |
| Retenção | A cada minuto o worker apaga do disco os segmentos vencidos e marca `deleted` no banco (a linha fica 30 dias). Nunca apaga fora da pasta de gravações. Mudar a retenção da câmera recalcula a validade do que já foi gravado |
| Saúde | Uma câmera "gravando" sem segmento conferido há 3 min volta a "ao vivo" e gera alerta (um a cada 30 min). Desligar a gravação, pela câmera ou pela chave geral, tira a câmera de "gravando" na hora |
| Painel | Os detalhes da câmera ganharam o bloco **Gravação**: situação, último segmento, horas disponíveis, retenção, espaço usado, lacunas em 24 h e problemas. Configurações ganhou a **chave geral da gravação** (Super Admin, auditada) |
| API | `GET /cameras/:id/recordings/summary` e `GET /cameras/:id/recordings?from&to` (segmentos conferidos e lacunas, até 7 dias). Operador e visualizador só acessam com a permissão **pode reproduzir** |
| CLI | `recording:status`: por câmera, horas disponíveis, espaço, segmento mais antigo, último segmento, problemas e lacunas em 24 h. Serve para acompanhar a retenção real |
| Permissões de disco | O servidor de mídia deixou de rodar como root e passou a gravar como o usuário 1000, o mesmo do worker, que precisa apagar os arquivos na retenção. O serviço `storage-init` ajusta a pasta a cada subida |
| Ao vivo | Pedido seu: **ativar o som troca aquele vídeo para HLS** quando o áudio da câmera não passa pelo WebRTC (AAC, caso da TWG 6608). Opus e G.711 continuam em WebRTC |

## Resultado do aceite

Evidência: `docs/evidencias/aceite-fase4-20260928.md` e o log dos testes. No aceite, a CAM-001 da Empresa Alfa (de teste) foi a câmera gravada e as CAM-002..005 ficaram só ao vivo.

| # | Critério | Resultado |
|---|---|---|
| R1 | O servidor de mídia grava só as câmeras marcadas | ✅ |
| R2 | Primeiro segmento conferido → "gravando" | ✅ em 57 s |
| R3 | Segmentos contínuos de ~60 s (janela com a câmera já gravando) | ✅ 60,0 s; maior intervalo 0,01 s |
| R4 | Câmeras só ao vivo: zero arquivos e zero registros | ✅ |
| R5 | Queda de 30 s: offline, lacuna registrada, volta a gravar | ✅ lacuna de 35,1 s (queda + reconexão) |
| R6 | Reinício do servidor de mídia | ✅ volta a gravar; trecho interrompido (23,9 s) conferido |
| R7 | API fora do ar por 80 s | ✅ os 2 segmentos do período indexados e conferidos pela varredura |
| R8 | Retenção | ✅ 9 vencidos apagados do disco e do banco; os 2 mais recentes mantidos |
| R9 | Outras câmeras gravando (informativo) | nenhuma no ambiente de desenvolvimento |
| R10 | Lint e testes | ✅ 104/104 |

**Primeira execução na VM (28/09, 23:13): 8/10.** As duas falhas vieram do roteiro, não da gravação:

- **R10:** o aceite rodou a imagem de testes antiga (85 testes da Fase 3). Reconstruída a imagem, deu **104/104 na VM**.
- **R3:** o transmissor da CAM-001, que sobrou da execução interrompida pela queda do SSH, foi religado no início e criou um trecho curto e uma lacuna de 7 s dentro da janela medida.
- **R9:** mostrou "nenhuma" por erro de SQL, embora a TWG estivesse gravando.

Na mesma VM, `recording:status` mostrou a TWG 6608 **gravando**: 24 segmentos, 260 MB em 21 min (≈18 GB/24 h) e nenhum problema. As 3 lacunas vieram da recriação e do reinício do servidor de mídia feitos pela atualização e pelo R6.

**Roteiro corrigido (evidência atual, 10/10 no ambiente de desenvolvimento):**

- o R10 sempre reconstrói a imagem de testes;
- o R3 mede só a partir da câmera já gravando;
- o R9 lista as câmeras reais com horas e espaço;
- a limpeza roda também se a conexão SSH cair, e as sobras de execuções interrompidas são removidas no início;
- o aceite avisa quando há câmeras reais gravando, e a opção `--skip-restart` pula o R6 (que interrompe todas as câmeras por alguns segundos).

## Problemas encontrados e corrigidos durante a fase

1. **Retenção sem permissão para apagar.** O MediaMTX gravava como root e o worker (usuário 1000) recebia `EACCES`.
   - **Solução:** o MediaMTX passou a rodar como o usuário 1000, e o `storage-init` ajusta a pasta.
2. **Arquivo inválido travava a conferência.** O ffprobe falhava e a tarefa ficava tentando de novo.
   - **Solução:** mídia inválida vira `corrupt` na hora. Só falhas passageiras (tempo esgotado) tentam de novo.
3. **Caminho fora da pasta de gravações interrompia a retenção.**
   - **Solução:** esses registros são limpos só no banco, sem tocar no disco.
4. **No próprio script de aceite:**
   - o R7 avaliava cedo demais;
   - a limpeza não devolvia o valor "desligado" da gravação da CAM-001 de teste (erro de SQL);
   - a evidência do R2 pegava um segmento antigo.
   - **Solução:** os três corrigidos.

## Mudanças em relação ao plano

| Plano | Implementado | Motivo |
|---|---|---|
| Retenção pelo worker | Igual, e o MediaMTX nunca apaga (`recordDeleteAfter: 0`) | O banco é a fonte da verdade |
| — | Varredura periódica da pasta, além dos avisos do MediaMTX | Nada se perde se a API cair ou o MediaMTX reiniciar |
| — | MediaMTX sem root e serviço `storage-init` | Necessário para a retenção apagar os arquivos |
| Chave geral (desligada até a Fase 4) | Ligada pela migration `0004` | Liberada agora que indexação e retenção existem |

## O que NÃO foi testado aqui (e como validar)

| Item | Situação | Como validar |
|---|---|---|
| VM Debian no Proxmox | Não executado | `scripts/accept-phase4.sh` deve dar 10/10 (~15 min) |
| **Retenção real de 24 h** | O aceite prova o expurgo adiantando a validade | Após 24 h e 30 h com a TWG gravando, `recording:status` deve mostrar o mais antigo em ~24 h e o espaço estável (~20 GB) |
| Gravação da TWG 6608 | Sem a câmera aqui | Ao atualizar, ela começa a gravar sozinha (já está marcada). Em até ~2 min deve aparecer "Gravando" nos detalhes |
| Disco cheio | Fica para a Fase 6 (cota, alertas 70/85/95% e parada controlada) | — |

## Pendências e observações

- **Espaço:** a TWG a 1,9 Mbps ocupa cerca de 20,5 GB em 24 h. A proteção contra disco cheio chega na Fase 6; até lá, a retenção de 24 h é o que limita o uso.
- **Reprodução:** o índice e as lacunas já estão prontos. Player, linha do tempo, calendário e exportação MP4 são a Fase 5.
- **Segmentos de 60 s:** a câmera só aparece como "gravando" cerca de 1 min depois de começar a transmitir. Isso é proposital: o estado só vale depois de um arquivo conferido.

## Atualizar a VM e validar

```bash
cd /opt/topcam
scripts/update.sh --bundle /root/topcam-fase4b.bundle
nohup scripts/accept-phase4.sh --no-build --skip-restart > /root/aceite4.log 2>&1 &
tail -f /root/aceite4.log                               # ~15 min; deve dar 9/9 aprovados (R6 pulado)
docker compose exec api node apps/api/dist/cli.js recording:status
git push
```

Depois de 24 h, rode `recording:status` de novo: a TWG 6608 deve mostrar cerca de 24 h disponíveis, com o segmento mais antigo sendo apagado conforme novos entram.

## Próxima fase (5): gravações — reprodução e linha do tempo

- Tela Gravações com calendário, linha do tempo com lacunas, player (velocidades) e exportação MP4.
- A exportação exige a permissão "pode exportar" e fica na auditoria.
