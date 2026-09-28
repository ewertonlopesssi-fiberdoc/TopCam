# TopCam — Relatório da Fase 2 (autenticação, multiempresa, cadastros e base visual)

28/09/2026 · **aceite: 12/12 critérios aprovados** e **E2E 10/10** (computador 1440 px, tablet 768 px e celular 390 px) no ambiente de desenvolvimento e **12/12 na VM de laboratório no Proxmox (28/09/2026, commit `998550f`)**.

## O que foi entregue

| Área | Entrega |
|---|---|
| Login e sessão | Login por e-mail e senha. Token de acesso de 15 min, mantido só em memória no navegador. Renovação por cookie httpOnly/SameSite=Strict (30 dias), trocado a cada uso. Reuso de um token já trocado encerra a sessão, com tolerância de 30 s para recargas de página. Troca de senha obrigatória no 1º acesso. Política de senha (mínimo 10 caracteres, letras e números, sem conter o e-mail). Bloqueio de 15 min após 5 erros no mesmo e-mail ou 20 no mesmo IP. Usuário, sessão e cliente são reconferidos a cada requisição: desativar alguém corta o acesso na hora |
| Papéis | Super Admin, Operador da plataforma, Administrador do cliente, Operador e Visualizador. Matriz única em `packages/shared/src/permissions.ts`, usada pela API e pelo painel |
| Permissão por câmera | Operador e Visualizador só enxergam as câmeras liberadas (`user_camera_permissions`). Câmera de outro cliente não pode ser liberada |
| Multiempresa | Toda consulta passa pelo RLS do PostgreSQL (Fase 1) com o escopo do usuário. A API também confere cliente, local e grupo em cada cadastro |
| Cadastros (API + telas) | **Clientes**: plano, contato, status, contagem de câmeras e usuários, limite do plano. **Usuários**: senha temporária exibida uma vez, redefinição, desativação e permissões por câmera. **Grupos/Locais**: árvore Local › Grupo. **Câmeras**: código CAM-### automático, chave exclusiva, "Exibir dados de configuração" (auditado), "Trocar chave", desabilitar, excluir, filtros e exportação CSV. **Configurações**: minha conta, troca de senha, nome da plataforma, e-mail de suporte e **limites dos planos editáveis** (decisão D9) |
| Auditoria | Tela com pesquisa (por ação, usuário ou cliente). Registra login, falha, bloqueio por tentativas, logout, troca de senha e todo cadastro, alteração, exclusão, permissão, exibição e troca de chave, com IP e navegador |
| Painel | Next.js 16 + Tailwind 4, com menu lateral, cabeçalho, cores e ordem de menu das imagens de referência. Abaixo de 1024 px o menu vira gaveta. Abaixo de 768 px as tabelas viram cartões. As telas Ao Vivo, Gravações, Eventos, Armazenamento, Servidores e Relatórios já aparecem no menu com o aviso da fase em que chegam |
| Infra | Serviço `web` no Compose. O gateway envia `/api/*` para a API e o resto para o painel, com cabeçalhos de segurança (X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy) e sem o cabeçalho `Server`. `generate-env.sh --add-missing` atualiza um `.env` existente |
| CLI | `user:create`, `user:reset-password` e `user:disable`, para recuperar acesso (ex.: único administrador bloqueado). Ficam na auditoria com o ator "cli" |
| Migration | `0003_fase2_cadastros.sql`: número sequencial e contato do cliente, índices, e `previous_refresh_hash`/`rotated_at` nas sessões |
| Testes | **73 testes automatizados** (18 novos só da Fase 2), **E2E Playwright** em 3 larguras e **aceite** `scripts/accept-phase2.sh` (12 critérios) |

## Resultado do aceite

Evidências completas:

- `docs/evidencias/aceite-fase2-20260928.md` e o log dos testes;
- capturas das telas em `docs/evidencias/fase2/`.

| # | Critério | Resultado |
|---|---|---|
| P1 | Painel pelo gateway, cabeçalhos de segurança, rotas internas bloqueadas | ✅ |
| P2 | Mensagem única para erro de login, 1º acesso exige troca de senha, cookie httpOnly/Strict | ✅ |
| P3 | Bloqueio após 5 tentativas erradas | ✅ 401 ×5 → 429 |
| P4 | Refresh rotacionado; logout invalida na hora | ✅ |
| P5 | Dois clientes fictícios com local, grupo e câmeras; chave exclusiva | ✅ 4 câmeras, 4 chaves |
| P6 | Administrador do cliente A não vê nada do B nem chaves, e não cria Super Admin | ✅ |
| P7 | Visualizador só vê a câmera liberada | ✅ 0 → 1 câmera; as demais retornam 404 |
| P8 | Exibir e trocar chave pelo painel | ✅ |
| P9 | Desabilitar câmera e suspender cliente | ✅ |
| P10 | Tudo na auditoria | ✅ 15 tipos de ação |
| P11 | Câmera cadastrada pelo painel recebe a transmissão e fica Ao vivo | ✅ em 5 s (H.264 640x360 15 fps) |
| P12 | Lint e testes | ✅ 73/73 |
| E2E | Fluxo completo do administrador e do visualizador; 8 telas sem rolagem horizontal em 1440, 768 e 390 px; menu em gaveta | ✅ 10/10 (o fluxo completo roda só na largura de computador; nas outras, as telas são percorridas uma a uma) |

## Problemas encontrados e corrigidos durante a fase

1. **Sessão perdida no celular.** Uma navegação interrompida reenviava o refresh token recém-trocado, e a detecção de roubo encerrava a sessão.
   - **Solução:** tolerância de 30 s para o token anterior (`rotated_at`). Fora dela, o reuso continua encerrando a sessão, com auditoria.
2. **Bloqueio por excesso de tentativas não aparecia na auditoria.**
   - **Solução:** novo evento `auth.login_rate_limited`, registrado uma vez por janela para não inundar a trilha.
3. **Limites dos planos só por SQL.**
   - **Solução:** tela e API para o Super Admin. A API recusa um limite de câmeras menor do que o maior cliente do plano já usa.
4. **Tabelas estreitas no celular.**
   - **Solução:** abaixo de 768 px, listas em cartões; colunas secundárias escondidas em tabelas pequenas.

## Mudanças em relação ao plano

| Plano | Implementado | Motivo |
|---|---|---|
| Dashboard com gráficos (tela 1 da referência) | Cartões com contagens reais (clientes, usuários, câmeras, online e offline) | Gráficos dependem de métricas coletadas (Fase 7) |
| Tela Relatórios no menu | Aviso "Fase 7" | Relatórios dependem de métricas e gravações |
| Exclusão de cliente | Status Suspenso/Cancelado, sem exclusão física | Preserva auditoria e histórico. Clientes cancelados podem ser filtrados na lista |

## O que NÃO foi testado aqui (e como validar)

| Item | Situação | Como validar |
|---|---|---|
| VM Debian no Proxmox | ✅ **12/12 em 28/09/2026** (73/73 testes; câmera ao vivo em 4 s). A 1ª execução deu 11/12: o `gateway` não foi recriado pelo `up --build` e seguia com o Caddyfile da Fase 1. Resolvido com `docker compose up -d --force-recreate gateway` (ver pendências) | — |
| Painel no navegador de vocês | Conferido só no Chromium do ambiente de testes | Abrir `http://172.31.141.20` no computador, tablet e celular e percorrer as telas |
| E2E contra a VM | Não executado | README, seção "Testes do painel (E2E)" |
| Cookie `Secure` | Desligado de propósito (laboratório em HTTP) | Liga com `COOKIE_SECURE=true` quando houver HTTPS (Fase 8) |
| Aplicativo mobile | A API já aceita `client: "mobile"` (refresh no corpo), mas não há app | Fase 9 |

## Pendências e observações

- **Atualização não recria o gateway:** arquivos de configuração montados (`Caddyfile`, `mediamtx.yml`) não fazem o Compose recriar o contêiner, e o `git pull` troca o arquivo. Até a correção permanente (proposta: pasta montada + `caddy --watch` e `scripts/update.sh`), rodar `docker compose up -d --force-recreate gateway mediamtx` depois de cada atualização.
- **Falha latente da Fase 1 corrigida:** no Caddyfile da Fase 1, `respond @internal 404` rodava depois dos blocos `handle` (ordem de diretivas do Caddy), então `/internal/*` devolvia o texto provisório com 200. Nada interno era exposto (esse caminho não chegava à API). A configuração da Fase 2 bloqueia corretamente (404).

- **Clientes do aceite:** cada execução do `accept-phase2.sh` deixa dois clientes "Aceite F2 …" com status **Cancelado**, sem câmeras. O usuário de aceite fica desativado. É proposital, para manter a trilha de auditoria.
- **Rate limit por IP:** 20 erros em 15 min no mesmo IP bloqueiam novas tentativas desse IP. Atrás de um NAT, vários usuários dividem o limite. Se isso incomodar, dá para ajustar `LOGIN_MAX_ATTEMPTS`.
- **Grupos por usuário:** a permissão é por câmera, como pede a especificação. Liberar um grupo inteiro de uma vez fica como melhoria de tela (a API já aceita a lista).

## Atualizar a VM e validar

```bash
cd /opt/topcam
git pull /caminho/topcam-fase2.bundle main   # ou git pull, depois do push para o GitHub
scripts/generate-env.sh --add-missing        # acrescenta JWT_SECRET e COOKIE_SECURE
docker compose up -d --build                 # aplica a migration 0003 e sobe o painel
docker compose ps                            # todos "healthy", incluindo web
scripts/accept-phase2.sh                     # ~3 min, gera reports/phase2-*.md
```

Depois, abra `http://172.31.141.20`, entre com `ADMIN_EMAIL` e `ADMIN_INITIAL_PASSWORD` do `.env` e defina a senha definitiva.

## Próxima fase (3): ao vivo

- Gateway com token assinado e HLS (+ WebRTC/WHEP).
- Tela Ao Vivo com mosaico 1/4/9/16 e árvore Empresa › Local › Grupo, com tela cheia.
- Permissão `pode_ao_vivo` respeitada.
- Latência medida e validação da TWG 6608.
