# Aceite da Fase 6 — 29/09/2026 12:12

Host: vm · versão: 0.1.0 · commit: f537b76

| # | Critério | Resultado | Evidência |
|---|---|---|---|
| S1 | Vigia mede o disco de vídeo (confere com o df) e a latência de escrita | ✅ PASSOU | storage-01: high, 90.60% usado, livre 25.4 GB (df: 25.4 GB), escrita 3 ms |
| S2 | 70% atenção e 85% alto, com evento na mudança e alerta (um só, atualizado) | ✅ PASSOU | 76% → warning 76.00% (alerta warning); 88% → high 88.00% (alerta error); eventos: warning,high |
| S3 | 95%: apaga o mais antigo do nó (mesmo dentro da retenção), volta abaixo do crítico; evento, alerta e auditoria; outros discos intocados | ✅ PASSOU | 1 segmento(s), 6.5 MB, câmeras {"CAM-001": 1}; mais antigo: apagado; mais novo: existe; depois: warning 73.00%; alerta warning; auditoria 1; limpeza em outros discos: 0 |
| S4 | Sem gravação apagável (mais nova que a idade mínima): a gravação do disco para, com alerta crítico | ✅ PASSOU | bloqueado: t; gravação no servidor de mídia: false; câmera: ao_vivo; alerta critical; limpezas: 0 |
| S4b | Com a gravação parada por disco cheio, o ao vivo e o painel continuam | ✅ PASSOU | endereço 200; HLS 200 (playlist válida); API 200 |
| S5 | Com espaço, a gravação volta sozinha e o alerta crítico se fecha | ✅ PASSOU | bloqueado: f; gravação: true; câmera: gravando; segmento novo conferido: sim; alerta aberto: 0 |
| S6 | Cota do cliente: só alerta (nada é apagado nem parado) | ✅ PASSOU | warning — Empresa Alfa: vídeo em 95% da cota; segmentos do cliente antes/depois: 8/8 |
| S7 | Telas Armazenamento e Servidores: dados da plataforma; usuário de cliente não acessa | ✅ PASSOU | armazenamento 200 (2 disco(s)); servidores 200; CPU 15%, memória 13%, disco do sistema 90.6%, espera por IO 0%; serviços: api=ok, redis=ok, worker=ok, database=ok, mediamtx=ok; cliente: 403/403 |
| S8 | Disco de vídeo real: latência de escrita (informativo) | ✅ PASSOU | escrita agora 1 ms; máxima em 24 h 1666 ms; 1 alerta(s) de disco lento em 24 h |
| S9 | Quadros perdidos dentro de segmentos nas câmeras reais em 24 h (informativo) | ✅ PASSOU | nenhum |
| S10 | Lint e testes automatizados | ✅ PASSOU | Tests 131 passed (131) (log: reports/phase6-20260929-115943-testes.log) |

**Total: 11/11 aprovados.**

Telas (Armazenamento e Servidores): E2E e2e/armazenamento.spec.ts.
