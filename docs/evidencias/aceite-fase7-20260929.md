# Aceite da Fase 7 — 29/09/2026 13:32

Host: vm · versão: 0.1.0 · commit: 48715b3

| # | Critério | Resultado | Evidência |
|---|---|---|---|
| M1 | Prometheus coleta o servidor (node-exporter), o servidor de mídia e a si mesmo | ✅ PASSOU | alvos: mediamtx=up, node=up, prometheus=up; séries de disco: 7 |
| M1b | Worker lê o Prometheus (serviço ok e tráfego de rede na tela Servidores) | ✅ PASSOU | prometheus=ok; rede recebendo 0.00 Mb/s |
| M2 | Integrações → e-mail: validação, senha cifrada e nunca devolvida, e-mail de teste entregue e registrado | ✅ PASSOU | sem senha → 400 (Informe a senha (no Gmail, a senha de app)); com senha → 200, hasPassword=true, senha na resposta: não; teste → 200, chegou: sim; registro: sent |
| M3 | Câmera cai → alerta "sem sinal" e e-mail em até 60 s (com link para o painel) | ✅ PASSOU | alerta em 9 s: CAM-001 · Entrada Principal (Empresa Alfa): câmera sem sinal (error); e-mail em 12 s: [TopCam] ERRO: CAM-001 · Entrada Principal (Empresa Alfa): câmera sem sinal |
| M4 | Câmera volta → alerta fecha sozinho e e-mail de "resolvido" | ✅ PASSOU | alerta fechado em 6 s; e-mail em 14 s: [TopCam] Resolvido: CAM-001 · Entrada Principal (Empresa Alfa): câmera sem sinal |
| M5 | Alertas: lista e filtros; reconhecer e resolver com autoria e auditoria; outro cliente não vê nem mexe | ✅ PASSOU | listado: true; ativos no sino: 7; Alfa vê: true; Sol vê: false (reconhecer → 404); reconhecido por Aceite7 alfa 133014 (200); resolvido por Aceite Fase 7 (200); auditoria: alert.resolved, alert.acknowledged |
| M6 | Dashboard, relatório de disponibilidade (JSON e CSV) e eventos com filtro; cliente só vê o que é dele | ✅ PASSOU | dashboard: 15 câmeras, 4 amostra(s) 24 h, 6 usuário(s) web; CAM-001 em 24 h: 5.7% no ar (50/880 s), 38 queda(s); CSV: ok; eventos "saiu do ar" da CAM-001 no aceite: 1; cliente: 5 câmera(s), de outros 0, integrações 403, disco no dashboard: oculto |
| M7 | Histórico gravado: amostras do dashboard (5 min) e horas de disponibilidade por câmera | ✅ PASSOU | 42 amostra(s) em 24 h (última 2026-09-29 16:30:16); 15 câmera(s) com horas nas últimas 2 h |
| M8 | Lint e testes automatizados | ✅ PASSOU | Tests 150 passed (150) (log: reports/phase7-20260929-133014-testes.log) |

**Total: 9/9 aprovados.**

E-mails do aceite foram para o Mailpit (servidor de teste). A configuração de e-mail do painel foi restaurada.
Telas (Dashboard, Eventos e Alertas, Relatórios, Integrações): E2E e2e/monitoramento.spec.ts.
