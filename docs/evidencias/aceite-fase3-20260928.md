# Aceite da Fase 3 — 28/09/2026 20:35

Host: ambiente de desenvolvimento (nuvem) · versão: 0.1.0 · código: entrega da Fase 3 · PUBLIC_HOST: localhost

| # | Critério | Resultado | Evidência |
|---|---|---|---|
| L1 | 5 câmeras recebidas por RTMP e ao vivo | ✅ PASSOU | CAM-001=ao_vivo, CAM-002=ao_vivo, CAM-003=ao_vivo, CAM-004=ao_vivo, CAM-005=ao_vivo (em 7 s) |
| L2 | Endereços temporários do ao vivo para as 5 câmeras, sem chave nem caminho interno | ✅ PASSOU | 5/5 endereços; validade 2026-09-29T01:34:59.000Z; vazamentos de chave/caminho: 0 |
| L3 | As 5 câmeras tocam por HLS através do gateway (playlist, init e segmento válidos) | ✅ PASSOU | CAM-001 h264 640x360; CAM-002 h264 640x360; CAM-003 h264 640x360; CAM-004 h264 640x360; CAM-005 h264 640x360 |
| L4 | WebRTC (WHEP): negociação pelo gateway e mídia anunciada em PUBLIC_HOST:8189 | ✅ PASSOU | resposta 201; candidatos: udp 127.0.0.1:8189, tcp 127.0.0.1:8189 |
| L5 | Token adulterado ou vencido = 403; caminho interno inacessível; visualizador só a câmera liberada; logout corta o vídeo | ✅ PASSOU | adulterado=403, vencido=403, /cam/ direto=404, /internal=404; visualizador: CAM-001=404, CAM-002=200, vídeo=200, após logout=403 |
| L7 | Atraso do HLS na borda do servidor (data do programa × relógio) — informativo | ✅ PASSOU | mediana 0.08 s (0.08, 0.08, 0.08, 0.08, 0.08); a latência na tela é medida no navegador (E2E) |
| L6 | Ao vivo não grava: nenhum arquivo nem registro de segmento | ✅ PASSOU | arquivos em /recordings: 0; recording_segments: 0 |
| L8 | Portas internas do servidor de mídia fechadas; 8189/UDP publicada para o WebRTC | ✅ PASSOU | não publicadas: 8888 8889 9997 9998 8554; publicadas indevidamente: nenhuma; 8189/udp → 0.0.0.0:8189 |
| L9 | Consumo com 5 câmeras recebidas e assistidas (informativo) | ✅ PASSOU | worker CPU 0.31% MEM 72.98MiB / 7.844GiB;api CPU 0.15% MEM 40.16MiB / 7.844GiB;mediamtx CPU 9.39% MEM 52.65MiB / 7.844GiB;gateway CPU 2.93% MEM 17.1MiB / 7.844GiB |
| L10 | Lint e testes automatizados | ✅ PASSOU | Tests 85 passed (85) (log: reports/phase3-20260928-203333-testes.log) |

**Total: 10/10 aprovados.**

Reprodução na tela, latência de ponta a ponta e corte do WebRTC ao retirar a permissão: E2E (e2e/ao-vivo.spec.ts) e conferência no navegador (docs/procedimento-teste-twg6608.md, item 5).
