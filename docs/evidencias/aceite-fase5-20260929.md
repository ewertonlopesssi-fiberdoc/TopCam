# Aceite da Fase 5 — 29/09/2026 07:56

Host: vm · versão: 0.1.0 · commit: e4795fc

| # | Critério | Resultado | Evidência |
|---|---|---|---|
| G1 | Servidor de reprodução ligado e só na rede interna | ✅ PASSOU | playback=true, endereço :9996; porta 9996 publicada: não |
| G2 | Calendário mostra o dia com gravação; a linha do tempo mostra a lacuna da queda | ✅ PASSOU | hoje (2026-09-29): 6 segmentos, 304 s; blocos contínuos em 3 h: 2; lacuna da queda: 35.1 s (10:52:37–10:53:12 UTC) |
| G3 | Reprodução pelo gateway com endereço temporário: fMP4 válido do trecho pedido | ✅ PASSOU | endereço 200; vídeo 200, 3.3 MB, h264+aac, 30.1 s (pedido 30 s); cache no-store; cookie: não |
| G4 | Reprodução recusada sem token válido, para outra câmera, com token do ao vivo, fora dos limites ou direto no servidor | ✅ PASSOU | sem token 403; adulterado 403; outra câmera 403; token do ao vivo 403; lista (/list) 403; mais de 1 h 400; formato mp4 400; direto no servidor, sem senha 401 |
| G5 | Visualizador: sem "pode reproduzir" nada; com ela só a câmera liberada; retirada corta o endereço já emitido | ✅ PASSOU | só ao vivo: reprodução 404, calendário 404; com permissão: 200, vídeo 200; outra câmera 404; após retirar: 403 |
| G6 | Exportação MP4 só com "pode exportar", com limites, arquivo válido e registro na auditoria | ✅ PASSOU | sem permissão 403; acima do máximo 400; futuro 400; sem gravação 404; pedido 200; download 200 13.2 MB h264+aac 120.0 s (pedido 120 s, gravado 122 s); CAM-001_2026-09-29_07-49-40_2min.mp4; link adulterado 403; auditoria: camera.exported, camera.export_requested |
| G7 | Exportação que atravessa uma lacuna traz todos os trechos gravados (lacuna removida do arquivo) | ✅ PASSOU | trecho 155 s, gravado 120 s; arquivo 200, h264+aac, 120.7 s |
| G8 | Lint e testes automatizados | ✅ PASSOU | Tests 112 passed (112) (log: reports/phase5-20260929-074919-testes.log) |

**Total: 8/8 aprovados.**

Tela (player, velocidades, calendário, linha do tempo, salto de lacunas, precisão do horário): E2E e2e/gravacoes.spec.ts.
