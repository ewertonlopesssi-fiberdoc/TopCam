# TopCam — Plano de execução e Fase 1

> Versão 1.1 · 26/09/2026 · Nome do sistema e do repositório: **TopCam** (antes VigiaTop) · Base: `especificacao-tecnica.md` + `instrucoes-do-projeto.md` + imagem de referência (6 telas).
> Status: plano aprovado em 26/09/2026. **Fase 1 concluída** (aceite 11/11 na VM). **Fase 2 concluída** (aceite 12/12 na VM; E2E 10/10). **Fase 3 concluída** (aceite 10/10 na VM; E2E; TWG 6608 validada). **Fase 4 entregue** (aceite na VM 9/9 com R6 pulado, e R6 aprovado antes; aguardando a prova de 24 h reais e a aprovação). **Fase 5 entregue** (gravações: aceite e E2E no ambiente de desenvolvimento; falta rodar na VM). Veja `fase-1-relatorio.md` a `fase-5-relatorio.md`.

---

## 1. Arquitetura

### 1.1 Visão geral

```
                    Internet / rede do ISP
   Câmeras ──RTMP(S) push──┐                 ┌──HTTPS── Navegador (painel) / App mobile
   (chave exclusiva)        │                 │
                     :1935/:1936          :443 (:80 só p/ certificado)
                            │                 │
                  ┌─────────▼───┐     ┌───────▼────────────────────────────┐
                  │  MediaMTX   │     │ Caddy (TLS, gateway, rate limit)    │
                  │ ingest/HLS/ │◄────┤  /api/*      → api                  │
                  │ WebRTC/     │     │  /live/*     → forward_auth(api) →  │
                  │ record/     │     │                mediamtx HLS/WebRTC  │
                  │ playback    │     │  /playback/* → forward_auth(api) →  │
                  └──┬───────┬──┘     │                mediamtx playback    │
      auth HTTP +    │       │        │  /*          → web (Next.js)        │
      hooks ─────────┘       │        └───────┬─────────────────────────────┘
                 │           │ segmentos fMP4 │
           ┌─────▼─────┐     ▼                ▼
           │   api     │  volume de   ┌─────────────┐
           │ Fastify/TS│  gravações   │ web Next.js │ (só consome a API — mesma API do app)
           └──┬─────┬──┘  (quota)     └─────────────┘
              │     │        ▲
      ┌───────▼┐  ┌─▼─────┐  │   ┌────────────────────────────────────────┐
      │Postgres│  │ Redis │◄─┴───┤ worker: indexação de segmentos, retenção│
      │ (RLS)  │  │BullMQ │      │ vigia de disco, reconciliação MediaMTX, │
      └────────┘  └───────┘      │ poller de status, alertas               │
                                 └────────────────────────────────────────┘
      Prometheus + node-exporter (métricas 7 dias) · backup → destino EXTERNO à VM
```

### 1.2 Serviços (Docker Compose, um contêiner por responsabilidade)

| Serviço | Tecnologia | Responsabilidade |
|---|---|---|
| `gateway` | Caddy 2 | TLS automático, roteamento, `forward_auth` para URLs assinadas de vídeo, limites de requisição |
| `web` | Next.js (React) + Tailwind + shadcn/ui | Painel responsivo seguindo as 6 telas de referência. Não acessa o banco, só a API |
| `api` | Node.js 22 + TypeScript + Fastify | Autenticação, autorização multiempresa, câmeras, chaves RTMP, hooks do MediaMTX, APIs do painel e do app |
| `worker` | Node.js + BullMQ (mesmo código-base) | Indexa e verifica segmentos, aplica retenção, vigia disco (70/85/95%), reconcilia configuração do MediaMTX, atualiza estados, gera alertas |
| `mediamtx` | MediaMTX | Recebe RTMP/RTMPS, valida publicação via API, entrega HLS/WebRTC (só pela rede interna), grava fMP4 e serve playback/export MP4 |
| `postgres` | PostgreSQL 16/17 | Fonte da verdade; isolamento por tenant com Row Level Security |
| `redis` | Redis 7 (ou Valkey) | Filas e cache. Estado crítico fica sempre no PostgreSQL |
| `prometheus` + `node-exporter` | Prometheus | Métricas de CPU, RAM, disco, rede e MediaMTX, com retenção de 7 dias |
| `backup` | pg_dump agendado | Dump para destino externo (definir — ver D6) |
| `test-transmitter` | ffmpeg (perfil `test`) | Simula 5 câmeras RTMP, chave inválida, publicação duplicada, queda e retorno |

### 1.3 Decisões técnicas principais

1. **Chave RTMP.** A câmera publica em `rtmp://video.<domínio>/live/<CHAVE>`. O MediaMTX consulta a API (`authHTTPAddress`) a cada publicação. A API compara o hash da chave, confere se a câmera e o cliente estão ativos e registra o evento. A segunda publicação na mesma chave é recusada (`overridePublisher: no`). Esse formato funciona em qualquer câmera que tenha os campos "URL + chave".
2. **A chave nunca chega ao espectador.** As portas HLS, WebRTC e playback do MediaMTX só ficam na rede interna. O navegador acessa `/live/<token-assinado>/index.m3u8`. O Caddy valida o token na API, que devolve o caminho interno, e só então encaminha. O token vai no caminho da URL para que os segmentos HLS relativos também saiam autenticados. Ele expira e fica vinculado ao usuário e à câmera.
3. **Gravação sem transcodificação.** O próprio MediaMTX grava segmentos fMP4 de 60 s (remux / stream copy). A gravação só é ligada no caminho das câmeras com `recording_enabled = true`. O diretório é por **ID da câmera**, não por chave, então rotacionar a chave não quebra o histórico.
4. **"Gravando" só após segmento durável.** O hook `runOnRecordSegmentComplete` avisa o worker. O worker verifica o arquivo (ffprobe + SHA-256), insere o registro em `recording_segments` numa transação e só então atualiza `last_durable_segment_at` e o estado `gravando`. `last_video_at` é atualizado separadamente, a partir do fluxo recebido.
5. **Retenção controlada pelo índice.** O worker apaga os arquivos com `expires_at` vencido e marca o registro como `deleted`. O `recordDeleteAfter` do MediaMTX fica como rede de segurança (retenção + 2 h). Um reconciliador detecta arquivo sem registro e registro sem arquivo.
6. **Multiempresa em duas camadas.** Todas as tabelas de negócio têm `tenant_id` e todas as consultas filtram por ele. Além disso, a RLS do PostgreSQL faz a mesma checagem: a conexão da API define `app.tenant_id` por transação, e mesmo um bug no código não vaza dados entre clientes.
7. **Pronto para migração.** A configuração fica 100% em variáveis de ambiente e volumes nomeados. Hostname estável desde o piloto. `ingest_nodes` e `storage_nodes` já existem no modelo: no servidor dedicado basta cadastrar mais nós, sem mudar código.
8. **Escala futura sem reescrita.** API e worker não guardam estado local, e a mídia é separada da aplicação. Os segmentos são indexados com `storage_node_id` e o armazenamento fica atrás de uma interface (hoje, disco local; depois, pool dedicado ou objeto S3).

---

## 2. Estrutura de diretórios

```
topcam/
├── apps/
│   ├── api/                 # Fastify: rotas, auth, RBAC, hooks MediaMTX
│   │   ├── src/{modules,plugins,lib}/
│   │   └── test/            # unit + integração (Postgres real)
│   ├── worker/              # jobs: segmentos, retenção, disco, reconciliação, status
│   ├── web/                 # Next.js: telas do painel (responsivo)
│   └── mobile/              # Expo/React Native (fase 9)
├── packages/
│   ├── db/                  # migrations SQL, seeds, tipos Kysely, políticas RLS
│   ├── shared/              # schemas Zod, enums de estado, matriz de permissões
│   ├── api-client/          # cliente tipado usado por web e mobile
│   └── ui/                  # tokens de cor/tema e componentes (padrão das imagens)
├── infra/
│   ├── compose/             # docker-compose.yml, perfis (lab, test), .env.example
│   ├── caddy/Caddyfile
│   ├── mediamtx/mediamtx.yml
│   ├── prometheus/
│   ├── backup/
│   └── vm/                  # preparo da VM Debian: firewall, volume de vídeo, logrotate
├── tools/
│   └── test-transmitter/    # ffmpeg: 5 câmeras simuladas + cenários de falha
├── scripts/                 # bootstrap, testes de aceite por fase, backup/restore
├── docs/                    # especificação, plano, runbooks, relatórios de fase
└── package.json / pnpm-workspace.yaml
```

---

## 3. Modelo de dados (versão final, criada já na Fase 1)

Todas as tabelas têm chave UUID (exceto segmentos e logs, que usam `bigint`), `created_at` e `updated_at`, além de `tenant_id` e RLS nas tabelas de negócio. As datas são gravadas em UTC e exibidas em America/Sao_Paulo.

| Tabela | Campos principais | Observações |
|---|---|---|
| `plans` | nome, max_cameras, max_storage_bytes, max_retention_hours, recursos (jsonb) | Básico / Pro / Enterprise das imagens; limites editáveis |
| `tenants` | nome, razão social, documento, plan_id, status (ativo/suspenso), quota de armazenamento | Cliente/Empresa |
| `roles` | chave (`platform_admin`, `platform_operator`, `tenant_admin`, `operator`, `viewer`), escopo | Papéis fixos no código, com permissões na matriz de `shared` |
| `users` | tenant_id (nulo = equipe da plataforma), nome, e-mail, hash argon2id, role_id, status, último login | |
| `sessions` | user_id, hash do refresh token, cliente (web/app), IP, expiração, revogação, last_seen | Alimenta "Usuários online (App/Web)" |
| `locations` | tenant_id, nome, endereço, fuso | "Matriz", "Filial 01"… |
| `camera_groups` | tenant_id, location_id, nome | Árvore Empresa › Local › Grupo das telas Ao Vivo/Gravações |
| `retention_policies` | tenant_id (nulo = global), nome, horas | Piloto: "24 h" |
| `cameras` | tenant_id, location_id, group_id, código (CAM-001), nome, protocolo de entrada (`rtmp_push`; `rtsp_pull` reservado), hash + cifra da chave, chave rotacionada em, recording_enabled, modo de gravação (`continuous`; `motion`/`event` reservados), retention_policy_id, ingest_node_id, storage_node_id, **status**, last_video_at, **last_durable_segment_at**, codec/resolução/fps/bitrate detectados, ativo | Estados: `aguardando_transmissao`, `conectando`, `recebendo`, `validando`, `ao_vivo`, `gravando`, `offline`, `erro`, `desabilitada` |
| `user_camera_permissions` | tenant_id, user_id, camera_id, pode_ao_vivo, pode_gravacoes, pode_exportar, concedido_por | Permissão individual por câmera |
| `ingest_nodes` | nome, host público, URL da API interna, capacidade, status, last_seen | Piloto: 1 nó |
| `storage_nodes` | nome, caminho, quota, uso, limites 70/85/95, status | Piloto: 1 nó (volume de vídeo) |
| `recording_segments` | tenant_id, camera_id, início/fim UTC, duração, codec, tamanho, sha256, storage_node_id, caminho, expires_at, estado (`writing`, `verified`, `corrupt`, `missing`, `deleted`) | Índices por (camera, início) e por expires_at; particionamento por dia quando a escala exigir |
| `camera_events` | tenant_id, camera_id, tipo, severidade, mensagem, dados, ocorreu_em | publish, queda, chave recusada, duplicada, codec, lacuna, disco… |
| `alerts` | tenant_id (nulo = plataforma), origem, regra, severidade, status (aberto/reconhecido/resolvido) | Tela "Eventos e Alertas" |
| `exports` | tenant_id, camera_id, solicitante, intervalo, status, arquivo, expiração | Toda exportação é auditada |
| `audit_logs` | tenant_id, ator, ação, entidade, IP, user agent, dados | Somente inserção (UPDATE/DELETE revogados) |
| `durable_jobs` | tipo, payload, estado, tentativas, próxima execução | Tarefas críticas não dependem só do Redis |
| `system_settings` | chave, valor | Limites de disco, parâmetros globais |

---

## 4. Dependências

**Infraestrutura (VM):** Debian 12 ou 13, Docker Engine + Compose v2, firewall (nftables), IP fixo, hostname público (ex.: `video.<domínio>`).

**Imagens:** `postgres`, `redis` (ou `valkey`), `bluenviron/mediamtx:*-ffmpeg`, `caddy`, `prom/prometheus`, `prom/node-exporter`, `node:22` (build da api/worker/web).

**Backend:** Fastify, Zod, Kysely + `pg`, argon2, `@fastify/jwt`, `@fastify/rate-limit`, BullMQ, pino.

**Frontend:** Next.js, React, Tailwind CSS, shadcn/ui (Radix), lucide-react, TanStack Query, Recharts, hls.js.

**Mobile (fase 9):** Expo / React Native.

**Testes:** Vitest (unitário e integração com Postgres real), Playwright (E2E do painel), ffmpeg/ffprobe (mídia).

As versões serão fixadas no lockfile e nas tags de imagem ao implementar a Fase 1.

---

## 5. Dúvidas e incompatibilidades a resolver

| # | Assunto | Situação / risco | Recomendação | Bloqueia |
|---|---|---|---|---|
| D1 | **TWG 6608: RTMP e codec** | ✅ **Resolvida (28/09/2026):** RTMP push com URL única (Rede › Serviço de rede); H.264 1080p 15 fps, AAC; recebida e exibida em WebRTC e HLS | Configuração recomendada: CBR ~1,75 Mbps, I Frame 2 s (≈20,5 GB/24 h) | Fase 3 |
| D2 | **H.265 e áudio no navegador** | H.265 via HLS toca no Safari e no Chrome com aceleração, mas não no Firefox. G.711 dentro de RTMP não é padrão e não toca no navegador | Piloto em **H.264 + AAC (ou sem áudio)**. H.265 fica suportado na gravação, com aviso de compatibilidade no player | Fase 3 |
| D3 | **Disco** | ✅ **Decidido (26/09/2026):** VM nova com **2 discos**: 25 GB para o sistema e 35 GB só para vídeo. 24 h a 2 Mbps ≈ 23,5 GB (≈ 67% do disco de vídeo, abaixo do alerta de 70%) | Disco de vídeo montado em `/srv/topcam/recordings`. Se o vídeo encher, só a gravação para | — |
| D4 | **Domínio, IP público e TLS** | Precisa de hostname estável, portas 443 e 1935 (e 1936 para RTMPS) e certificado | Hostname definitivo desde já (ex.: `video.seudominio.com.br`), Let's Encrypt via Caddy. No início, o lab pode rodar sem TLS na rede interna | Fase 8 (HTTPS obrigatório antes de acesso externo) |
| D5 | **App mobile** | A especificação deixa a escolha em aberto | Painel web responsivo primeiro. App em **Expo/React Native** (iOS e Android), usando a mesma API | Fase 9 |
| D6 | **Backup externo** | O destino não está definido | Proxmox Backup Server para a VM + pg_dump diário para NFS/SMB ou S3 externo. Informe qual existe | Fase 8 |
| D7 | **Canais de alerta** | Não especificados | Alertas no painel + e-mail. Telegram/WhatsApp opcionais | Fase 7 |
| D8 | **Imagem × especificação** | As imagens mostram câmeras **RTSP** e "tipo de gravação: Movimento/Evento". A especificação prevê só RTMP push e gravação contínua | Modelo já preparado (`rtsp_pull`, `motion`, `event`), mas só RTMP + contínua implementados. Detecção de movimento exige decodificação (CPU), o que contraria "sem transcodificação". Só incluo se você aprovar como escopo novo. O botão **"Importar"** da tela Câmeras também contraria a especificação ("não incluir cadastro em massa na primeira versão"): na primeira versão ele fica fora, só com a opção "Exportar" | — |
| D9 | **Limites dos planos** | Nomes aparecem nas imagens, valores não | Valores padrão editáveis no painel | Fase 2 |
| D10 | **Repositório** | ✅ **Decidido:** repositório privado **TopCam** na conta `ewertonlopesssi-fiberdoc` | O push é feito pelo Ewe (sem acesso à conta a partir daqui) | — |
| D11 | **Meu ambiente de teste** | Aqui na nuvem tenho Docker, Node 22, ffmpeg e psql, mas o Docker Hub está limitando downloads (erro 429) e o GitHub Releases está bloqueado | Rodo aqui tudo o que for possível. O teste completo com `docker compose` na sua VM terá um script de aceite que gera o relatório. Se a imagem não puder ser baixada aqui, digo exatamente o que não foi testado | — |

---

## 6. Fases de desenvolvimento

Cada fase termina com: código, migrations (se houver), testes automáticos, script de aceite, relatório (arquivos, testes, resultados, pendências) e sua aprovação.

| Fase | Entrega | Critérios objetivos de aprovação (resumo) |
|---|---|---|
| **1. Fundação + ingestão RTMP autenticada** ✅ | Monorepo, Compose, modelo de dados completo + RLS, seed, API de health e hooks, transmissor de teste | Ver seção 7. **Concluída: 11/11** |
| **2. Autenticação, multiempresa e cadastros + base visual** ✅ | Login (JWT + refresh), papéis, permissões por câmera, auditoria. Telas Clientes, Usuários, Grupos/Locais, Câmeras (cadastro individual, gerar/rotacionar/exibir chave), Configurações, com layout da referência (menu lateral, cabeçalho, cores) responsivo | Dois clientes fictícios isolados; viewer só vê câmeras permitidas; toda alteração aparece na auditoria; telas conferidas em 1440 px, 768 px e 390 px. **Concluída: 12/12 na VM + E2E** |
| **3. Ao vivo** ✅ | Gateway com token assinado, HLS (+ WebRTC/WHEP), tela Ao Vivo com mosaico 1/4/9/16, árvore Empresa › Local › Grupo, tela cheia | 5 câmeras simuladas ao vivo; token expirado/de outro usuário = 403; chave nunca aparece no navegador; latência medida e registrada; **validação da TWG 6608 (D1)**. **Concluída: 10/10 na VM + E2E; TWG 6608 validada em RTMP/H.264, latência < ~1 s** |
| **4. Gravação e retenção** 🟡 | Gravação só da CAM-001, verificação e indexação de segmentos, estado "gravando", lacunas, retenção de 24 h, reconciliador | CAM-001 com segmentos contínuos; CAM-002..005 com **zero** arquivos e zero registros; expurgo comprovado (retenção reduzida no teste + execução de 24 h real); queda gera lacuna e evento. **Entregue: aceite na VM (9/9 + R6 aprovado antes); TWG 6608 gravando; falta a prova de 24 h reais** |
| **5. Gravações: reprodução e linha do tempo** 🟡 | Tela Gravações: calendário, timeline com lacunas, player, velocidade, exportação MP4 autorizada e auditada | Reproduzir trecho escolhido; exportar MP4 válido (ffprobe); usuário sem `pode_exportar` = 403; exportação na auditoria. **Entregue: aceite 8/8 e E2E no ambiente de desenvolvimento; falta a VM** |
| **6. Armazenamento e proteção de disco** | Quota de vídeo, alertas 70/85/95%, parada controlada da gravação, tela Armazenamento e Servidores | Encher o volume de teste até 95%: gravação para com evento e alerta, banco e sistema seguem funcionando; retomada automática ao liberar espaço |
| **7. Monitoramento, dashboard, eventos e relatórios** | Prometheus, dashboard (tela 1), Eventos e Alertas, Servidores, Relatórios, alertas por e-mail | Cartões e gráficos com dados reais; queda de câmera gera alerta em ≤ 60 s; métricas de 7 dias disponíveis |
| **8. Segurança, backup e resiliência** | HTTPS/RTMPS, rate limit, rotação de segredos, backup externo, restauração, testes de reinício | Restauração em VM limpa validada; reinício de contêiner e da VM sem perda de índice; teste de falta de espaço; **teste contínuo de 7 dias** |
| **9. App mobile** | Expo: login, grupos, ao vivo, reprodução da CAM-001, eventos, conta | Build Android/iOS de teste; mesmas permissões da API; câmeras de outro cliente inacessíveis |
| **10. Aceite do piloto + runbook de migração** | Checklist da seção 7 da especificação, relatório de capacidade medida, roteiro de migração para o servidor dedicado | Todos os critérios de aceite do piloto verificados e documentados |

---

## 7. Fase 1 — Fundação e ingestão RTMP autenticada (detalhe)

### 7.1 Escopo

1. Monorepo (pnpm, TypeScript, lint, formatação, Vitest).
2. `docker-compose.yml` com postgres, redis, mediamtx, api, worker, gateway e o perfil `test` com o transmissor. Health checks em todos os serviços, logs com rotação (`max-size`) e volumes nomeados.
3. **Migrations do modelo completo** (seção 3) com políticas RLS, papel de banco sem `BYPASSRLS` para a API e `audit_logs` somente de inserção.
4. **Seed:** planos, equipe da plataforma (admin), dois clientes fictícios ("Empresa Alfa" e "Condomínio Sol"), locais e grupos. CAM-001 a CAM-005 na Empresa Alfa (só a CAM-001 com `recording_enabled`) e uma câmera no Condomínio Sol para o teste de isolamento.
5. **Chaves RTMP:** geração (≥ 32 caracteres aleatórios), hash SHA-256 para busca, cópia cifrada (AES-256-GCM) para exibição ao administrador e rotação. Na Fase 1 isso é feito por comando de CLI; a tela chega na Fase 2.
6. **API:** `/health`, `/ready`, `POST /internal/mediamtx/auth` (valida publish: chave, câmera ativa, cliente ativo, rejeita publicação duplicada) e hooks `ready`/`not-ready`, com registro em `camera_events`.
7. **Máquina de estados** da câmera: `aguardando_transmissao → conectando → recebendo → validando → ao_vivo`, além de `offline` e `erro`. `last_video_at` é atualizado pelo worker (poller da API do MediaMTX, a cada 10 s), e codec, resolução e fps detectados são gravados na câmera.
8. **Reconciliador do MediaMTX:** a configuração de cada caminho sai do banco. Na Fase 1 a gravação fica **desligada em todas** as câmeras; ela só é ligada na Fase 4, depois do indexador pronto.
9. **Transmissor de teste:** ffmpeg com `testsrc2` (H.264 + AAC, 2 Mbps, com relógio na imagem) para as 5 chaves, mais os cenários `chave-invalida`, `duplicada` e `queda` (derruba e reconecta).
10. Script `scripts/accept-phase1.sh`, que executa todos os critérios abaixo e gera um relatório.

**Fora da Fase 1:** telas, reprodução ao vivo no navegador e gravação.

### 7.2 Critérios de aprovação

| # | Critério | Como é verificado |
|---|---|---|
| 1 | `docker compose up -d` em VM limpa → todos os serviços `healthy` em ≤ 2 min | script |
| 2 | Migrations aplicam do zero; reaplicar não altera nada | teste de integração |
| 3 | 5 transmissões com chaves válidas → as 5 câmeras chegam a `ao_vivo` em ≤ 15 s, com codec, resolução e fps gravados | script + consulta SQL |
| 4 | Chave inválida → publicação recusada e evento `auth_rejected` com IP de origem | script |
| 5 | Segunda publicação na mesma chave → recusada, com evento `duplicate_publish_rejected`; a transmissão original continua | script |
| 6 | Transmissão interrompida → `offline` em ≤ 15 s + evento; ao voltar, retorna a `ao_vivo` | script |
| 7 | Após 10 min com as 5 transmissões: **0 arquivos** no volume de gravações e **0 registros** em `recording_segments` | script |
| 8 | Isolamento: sessão de banco do Condomínio Sol não enxerga câmeras da Empresa Alfa (RLS), nem com consulta sem filtro | teste de integração |
| 9 | Rotação de chave: a chave antiga é recusada e a nova é aceita, sem mudar o ID da câmera | script |
| 10 | Reinício do contêiner `api`: as transmissões continuam. Reinício do `mediamtx`: o transmissor reconecta e os estados se recuperam | script |
| 11 | Testes unitários e de integração 100% aprovados; lint sem erros | CI local |

### 7.3 O que você recebe ao final da Fase 1

- Código no repositório (D10), com o README de instalação na VM Debian.
- Relatório da fase: arquivos criados, testes executados aqui e o resultado de cada um, o que **não** pôde ser testado aqui (ver D11) e o comando para você rodar na VM.
- Procedimento de verificação da TWG 6608 (D1), para você executar enquanto eu avanço para a Fase 2.

---

## 8. Para começar a Fase 1, preciso de

1. **Aprovação** deste plano (ou ajustes).
2. Resposta à dúvida que afeta o início: **D10** (conta GitHub). D3 já está decidida. As demais podem ser respondidas ao longo das fases.

### VM a criar no Proxmox (decisão D3)

| Item | Valor |
|---|---|
| SO | Debian 12 ou 13 (netinst, sem ambiente gráfico, com SSH) |
| CPU / RAM | 4 vCPU (tipo `host`) / 8 GB |
| Controladora | VirtIO SCSI single |
| Disco 1 (`scsi0`) | 25 GB — sistema, Docker, banco, logs, métricas. Discard + SSD emulation ligados |
| Disco 2 (`scsi1`) | 35 GB — **não formatar na instalação**; o script `infra/vm/` da Fase 1 formata e monta em `/srv/topcam/recordings` |
| Rede | VirtIO, IP fixo |
| Opções | QEMU Guest Agent ligado. Backup do Proxmox só no disco 1: desmarcar "Backup" no disco 2, porque as gravações duram 24 h e copiá-las tomaria espaço à toa |
3. Se já tiver: resultado da D1 (a TWG 6608 tem RTMP? que campos aparecem?).
