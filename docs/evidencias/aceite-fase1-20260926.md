# TopCam — Relatório de aceite da Fase 1

- Data: 26/09/2026 12:21:56 -03
- Host: vm · Linux 6.18.44-fc-v37 · Docker 29.4.3
- Versão: 0.1.0 · Transmissões de teste: 640x360 @ 15 fps, 800k
- Resultado: **11/11 critérios aprovados**

| # | Critério | Resultado | Evidência |
|---|---|---|---|
| 1 | Ambiente sobe com todos os serviços saudáveis em ≤ 2 min | ✅ PASSOU | 6 serviços healthy em 11s após o up (34s incluindo build) |
| 2 | Migrations aplicam do zero e reaplicar não altera nada | ✅ PASSOU | 2ª execução: 0 aplicadas; assinatura do esquema igual (d787271b) |
| 3 | 5 câmeras com chaves válidas chegam a 'ao_vivo' em ≤ 15 s, com codec/resolução/fps | ✅ PASSOU | CAM-001: 7s (h264 640x360 15.00fps); CAM-002: 7s (h264 640x360 15.00fps); CAM-003: 6s (h264 640x360 15.00fps); CAM-004: 7s (h264 640x360 15.00fps); CAM-005: 6s (h264 640x360 15.00fps);  |
| 4 | Chave inválida é recusada, com evento auth_rejected e IP de origem | ✅ PASSOU | ffmpeg saiu com código 255; 1 evento(s); IP registrado: 172.18.0.13 |
| 5 | Segunda publicação na mesma chave é recusada e a original continua | ✅ PASSOU | evento duplicate_publish_rejected; CAM-002 segue 'ao_vivo' com a mesma conexão (4ee9e079) |
| 6 | Queda → 'offline' em ≤ 15 s com evento; ao voltar → 'ao_vivo' | ✅ PASSOU | offline em 1s (1 evento stream_offline); de volta ao vivo em 6s |
| 7 | Após 10 min com 5 transmissões: 0 arquivos e 0 segmentos | ✅ PASSOU | 10 min no ar; 5/5 ao vivo; arquivos=0; recording_segments=0; caminhos com record=true: 0 |
| 8 | Condomínio Sol não enxerga dados da Empresa Alfa, nem com consulta sem filtro | ✅ PASSOU | escopo Sol: 1 câmera própria, 0 de outros clientes, 0 eventos alheios; sem escopo: 0 |
| 9 | Rotação: chave antiga recusada, nova aceita, mesmo ID da câmera | ✅ PASSOU | publicador antigo desconectado em 1s; nova tentativa com a chave antiga recusada (ffmpeg código 255, evento auth_rejected); estado entre as chaves: 'offline'; chave nova ao vivo em 5s; ID 4fab4667 mantido |
| 10 | Reinício da API não derruba transmissões; reinício do MediaMTX se recupera | ✅ PASSOU | API: 5/5 conexões intactas; MediaMTX: 5 câmeras ao vivo de novo em 12s |
| 11 | Testes unitários e de integração 100% aprovados; lint sem erros | ✅ PASSOU |  Test Files 5 passed (5); Tests 55 passed (55); |

## Câmeras ao final

| Cliente | Câmera | Estado | Vídeo | kbps | Gravação habilitada |
|---|---|---|---|---|---|
| condominio-sol | CAM-001 | aguardando_transmissao | - x | - | false |
| empresa-alfa | CAM-001 | ao_vivo | h264 640x360 | 873 | true |
| empresa-alfa | CAM-002 | ao_vivo | h264 640x360 | 881 | false |
| empresa-alfa | CAM-003 | ao_vivo | h264 640x360 | 870 | false |
| empresa-alfa | CAM-004 | ao_vivo | h264 640x360 | 872 | false |
| empresa-alfa | CAM-005 | ao_vivo | h264 640x360 | 873 | false |

## Eventos registrados durante o teste

- auth_rejected: 3
- codec_detected: 12
- duplicate_publish_rejected: 1
- key_rotated: 1
- publish_authorized: 12
- publisher_kicked: 1
- stream_offline: 6
- stream_online: 12

Saída completa dos testes automatizados: `reports/phase1-20260926-121117-tests.log`
