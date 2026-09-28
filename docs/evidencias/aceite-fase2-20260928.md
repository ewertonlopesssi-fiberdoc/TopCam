# Aceite da Fase 2 — 28/09/2026 19:24

Host: ambiente de desenvolvimento (nuvem) · versão: 0.1.0 · código: entrega da Fase 2 (commit seguinte a 93e82ea)

| # | Critério | Resultado | Evidência |
|---|---|---|---|
| P1 | Painel publicado pelo gateway, com cabeçalhos de segurança; rotas internas bloqueadas | ✅ PASSOU | /login=200, X-Frame-Options=DENY, nosniff=nosniff, Server=(oculto), /internal=404 |
| P2 | Login com mensagem única para erro; troca de senha obrigatória no 1º acesso; cookie httpOnly/Strict | ✅ PASSOU | senha errada=401, e-mail inexistente=401 (mesma msg: true), 1º acesso bloqueado=403/password_change_required, cookie="Max-Age=2592000; Path=/api/v1/auth; HttpOnly; SameSite=Strict", após troca=200 |
| P3 | Bloqueio após 5 tentativas erradas no mesmo e-mail (15 min) | ✅ PASSOU | respostas: 401, 401, 401, 401, 401, 429 |
| P4 | Refresh token rotacionado a cada uso; logout invalida acesso e refresh na hora | ✅ PASSOU | refresh=200 (cookie novo: true), logout=200, /me depois=401, refresh depois=401 |
| P5 | Cadastro de clientes, local, grupo e câmeras pelo painel/API; chave exclusiva por câmera | ✅ PASSOU | clientes aceite-f2-a-192313 e aceite-f2-b-192313; 4 câmeras, 4 chaves distintas; servidor rtmp://localhost:1935/live |
| P6 | Administrador do cliente A não enxerga nada do cliente B nem as chaves; não cria papel da plataforma | ✅ PASSOU | câmeras visíveis=2 (todas do A), câmera do B=404, cliente B=403, clientes listados=1, ver chave=403, criar Super Admin=403 |
| P7 | Visualizador vê só as câmeras concedidas; permissão com câmera de outro cliente é recusada | ✅ PASSOU | antes da permissão=0, depois=1, câmera não concedida=404, câmera do B=404, editar=403, usuários=403, conceder câmera do B=400 |
| P8 | Exibir e trocar a chave de transmissão pelo painel (chave nova substitui a antiga) | ✅ PASSOU | exibir=ok, trocar=200, chave nova ≠ antiga: true |
| P9 | Desabilitar câmera e suspender cliente | ✅ PASSOU | desabilitar=200 → desabilitada; suspender=200 → suspended |
| P10 | Toda alteração e acesso a chave aparece na auditoria | ✅ PASSOU | 15 tipos de ação conferidos |
| P11 | Câmera cadastrada pelo painel recebe a transmissão com a chave exibida e fica Ao vivo | ✅ PASSOU | estados: conectando → validando → ao_vivo em 5s; h264 640x360 @ 15 fps |
| P12 | Lint e testes automatizados | ✅ PASSOU | Tests 73 passed (73) (log: reports/phase2-20260928-192313-testes.log) |

**Total: 12/12 aprovados.**

Telas (1440/768/390 px): conferidas pelos testes E2E (Playwright) — veja README, seção "Testes do painel".
