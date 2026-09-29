# Aceite da Fase 4 — 28/09/2026 23:37

Host: ambiente de desenvolvimento (nuvem) · versão: 0.1.0 · código: entrega da Fase 4 (roteiro corrigido)

| # | Critério | Resultado | Evidência |
|---|---|---|---|
| R1 | Chave geral ligada; o servidor de mídia grava só as câmeras com gravação marcada | ✅ PASSOU | gravando no servidor: 1 caminho(s) = câmeras marcadas (1); CAM-001 de teste incluída: sim |
| R2 | Primeiro segmento conferido (tamanho, SHA-256, ffprobe) e só então "gravando" | ✅ PASSOU | gravando em 57 s; 1º segmento: 63438 ms, 6385 kB, h264/aac, sha256 bc73d7d8a804… |
| R3 | Segmentos contínuos de ~60 s, sem lacunas com a transmissão no ar | ✅ PASSOU | 2 segmentos conferidos; duração 60.0–60.0 s; maior intervalo entre segmentos: 0.01 s |
| R4 | Câmeras só ao vivo (CAM-002..005): zero arquivos e zero registros | ✅ PASSOU | ao vivo: 4/4; arquivos: 0; registros: 0 |
| R5 | Queda de 30 s: offline, lacuna registrada e volta a gravar | ✅ PASSOU | evento offline: 1; lacuna: 35.1 s; estado: gravando |
| R6 | Reinício do servidor de mídia: a gravação volta e o trecho interrompido é indexado | ✅ PASSOU | segmentos conferidos após o reinício: 1; trecho interrompido: verified 23.9 s |
| R7 | API fora do ar: a varredura do worker indexa e confere o que os avisos perderam | ✅ PASSOU | segmentos gravados com a API fora do ar, conferidos: 2; pendentes: 0; arquivos sem registro conferido: 0 |
| R8 | Retenção: vencidos apagados do disco e do índice; os demais e as outras câmeras intactos | ✅ PASSOU | vencidos: 9; arquivos que sobraram: 0; mantidos: 2/2; outras câmeras: 0 antes, 0 depois |
| R9 | Outras câmeras gravando (informativo) | ✅ PASSOU | nenhuma |
| R10 | Lint e testes automatizados | ✅ PASSOU | Tests 104 passed (104) (log: reports/phase4-20260928-232425-testes.log) |

**Total: 10/10 aprovados.**

Retenção real de 24 h: acompanhar com `docker compose exec api node apps/api/dist/cli.js recording:status` (o mais antigo deve ficar em ~24 h e o espaço estável).
