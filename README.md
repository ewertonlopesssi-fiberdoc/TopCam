# TopCam

Plataforma multiempresa de câmeras IP: recebe câmeras por **RTMP push** (cada uma com chave exclusiva), mostra ao vivo, grava as câmeras autorizadas com retenção configurável e isola os dados de cada cliente.

O laboratório roda numa única VM Debian no Proxmox (disco de 25 GB para o sistema + 35 GB para vídeo). Todos os serviços ficam em contêineres separados, para que a migração ao servidor dedicado mude apenas configuração e escala.

> **Estado atual: Fase 3 — ao vivo no navegador (WebRTC e HLS).** Painel com login, papéis, permissões por câmera, cadastros e a tela Ao Vivo. A gravação (Fase 4) ainda não está disponível; as telas das fases seguintes aparecem no menu com o aviso da fase. Veja `docs/plano-de-execucao.md`.

---

## Arquitetura

```
Câmera / transmissor ──RTMP :1935──► mediamtx ──auth HTTP + hooks──► api ──► PostgreSQL (RLS)
                                        ▲                             │
                                        │ API de controle              ▼
                                        └────────── worker ◄──── Redis (acordar tarefas)
Navegador ──HTTP :80──► gateway (Caddy) ──/api/*──────────► api
                                         ├──/live/<token>/*──► (api confere o token) ──► mediamtx HLS/WHEP
                                         └──/*──────────────► web (Next.js, painel)
Navegador ◄──── mídia WebRTC :8189 (UDP/TCP) ──── mediamtx
```

| Serviço    | Papel                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| `postgres` | Fonte da verdade. Row Level Security isola os clientes.                                                       |
| `redis`    | Acorda o worker quando há tarefa nova. Tarefas críticas ficam no PostgreSQL (`durable_jobs`).                 |
| `migrate`  | Aplica migrations e o seed idempotente e termina.                                                             |
| `api`      | API REST do painel e do app (login, cadastros, permissões, auditoria) e autorização/hooks do MediaMTX.        |
| `worker`   | Valida o vídeo (ffprobe), mantém os caminhos do MediaMTX iguais ao banco, monitora estados, bitrate e quedas. |
| `mediamtx` | Recebe RTMP e entrega o ao vivo (HLS/WebRTC). API, RTSP, HLS e a sinalização WebRTC ficam só na rede interna. |
| `web`      | Painel administrativo (Next.js). Só consome a API, a mesma que o app mobile usará.                            |
| `gateway`  | Entrada HTTP. Bloqueia rotas internas, confere o token do ao vivo na API, aplica cabeçalhos de segurança.     |

### Caminhos no servidor de mídia

- `live/<CHAVE>`: onde a câmera publica. Nunca grava. Recusa uma segunda publicação na mesma chave.
- `cam/<ID da câmera>`: relay interno de `live/<CHAVE>`, sem transcodificar. É o caminho usado na gravação (Fase 4) e na visualização (Fase 3). A chave nunca aparece em nomes de arquivo nem em URLs de leitura, e trocar a chave não quebra o histórico.

### Estados da câmera

`aguardando_transmissao → conectando → recebendo → validando → ao_vivo → gravando`, mais `offline`, `erro` e `desabilitada`.

- **"Gravando"** só é alcançado depois que um segmento durável é confirmado no banco (Fase 4).
- **`last_video_at`** só avança quando os bytes recebidos crescem. Uma câmera conectada mas "congelada" cai para `offline` (motivo `video_stalled`).

---

## Instalação na VM (Debian 12/13)

1. **Criar a VM no Proxmox:** 4 vCPU, 8 GB de RAM, VirtIO SCSI single.
   - Disco 1: 25 GB para o sistema.
   - Disco 2: 35 GB para vídeo, sem formatar e com backup desmarcado.
   - Rede VirtIO com IP fixo.
2. **Preparar a VM** (como root). O script instala o Docker, limita os logs e formata e monta o disco de vídeo em `/srv/topcam/recordings`:
   ```bash
   git clone https://github.com/ewertonlopesssi-fiberdoc/TopCam.git /opt/topcam
   cd /opt/topcam
   lsblk   # o nome (sda/sdb) pode mudar entre reinícios: confira pelo TAMANHO (35G) ou use /dev/disk/by-id/*drive-scsi1
   ./infra/vm/prepare-vm.sh --video-disk /dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_drive-scsi1
   # opcional: --firewall --admin-cidr 192.168.10.0/24  (SSH só da rede de administração)
   ```
   O script **recusa** formatar um disco que já tenha dados. Para isso, use `--force-format`.
3. **Configurar:**
   ```bash
   scripts/generate-env.sh --public-host video.seudominio.com.br --admin-email voce@dominio.com.br
   ```
   Guarde uma cópia segura do `.env`, principalmente `STREAM_KEY_ENC_KEY`: sem ela não é possível exibir as chaves das câmeras.
4. **Subir:**
   ```bash
   docker compose up -d --build
   docker compose ps          # todos "healthy"
   ```
5. **Validar** com o transmissor de teste (gera `reports/phase*-*.md`):
   ```bash
   scripts/accept-phase1.sh     # ingestão RTMP, ~12 min
   scripts/accept-phase2.sh     # login, isolamento, permissões, auditoria, ~3 min
   scripts/accept-phase3.sh     # ao vivo das 5 câmeras (HLS, WebRTC, segurança), ~3 min
   ```
6. **Entrar no painel:** `http://<PUBLIC_HOST>` com `ADMIN_EMAIL` e `ADMIN_INITIAL_PASSWORD` do `.env`. No primeiro acesso o sistema exige a troca da senha (mínimo 10 caracteres, letras e números, sem conter o e-mail).

### Atualizar uma instalação existente

```bash
cd /opt/topcam
scripts/update.sh                            # do GitHub
scripts/update.sh --bundle /root/arquivo.bundle   # ou de um pacote .bundle
```

O script faz, em sequência: `git pull`, acrescenta ao `.env` as variáveis novas (sem mexer nas atuais), constrói e sobe tudo (o serviço `migrate` aplica as migrations novas), recria o gateway e o servidor de mídia quando a configuração deles muda e espera todos ficarem saudáveis. Ele recusa atualizar se houver alterações locais nos arquivos do projeto.

### Portas

| Porta               | Uso                     | Exposição                                       |
| ------------------- | ----------------------- | ----------------------------------------------- |
| 1935/tcp            | RTMP das câmeras        | Pública (ou só na rede das câmeras)             |
| 80/tcp              | Gateway HTTP            | Pública. 443 entra na Fase 8                    |
| 8189/udp e 8189/tcp | Mídia WebRTC do ao vivo | Rede de quem assiste. Sem ela, o painel usa HLS |
| 22/tcp              | SSH                     | Somente rede de administração                   |

Postgres, Redis, API do MediaMTX, RTSP, HLS e a sinalização WebRTC **não** são publicados. A porta 8189 precisa ser a mesma dentro e fora (é a anunciada ao navegador, no endereço `PUBLIC_HOST`).

---

## Painel

| Papel                  | O que faz                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| Super Admin            | Tudo: clientes, planos, usuários, câmeras, chaves de transmissão, configurações, auditoria     |
| Operador da plataforma | Opera clientes e câmeras de todos os clientes; vê chaves                                       |
| Administrador cliente  | Usuários, locais, grupos e permissões do próprio cliente; vê todas as câmeras dele, sem chaves |
| Operador               | Só as câmeras liberadas para ele                                                               |
| Visualizador           | Só as câmeras liberadas para ele, somente leitura                                              |

- **Câmeras → Nova Câmera** gera o código (CAM-###) e a chave exclusiva e mostra servidor, chave e URL completa para configurar a câmera. Depois, a chave só aparece em "Exibir dados de configuração" (registrado na auditoria). "Trocar chave" invalida a anterior e desconecta quem a usa.
- **Usuários** cria o acesso com senha temporária (exibida uma única vez) e define, por usuário, quais câmeras ele vê.
- **Ao Vivo:** árvore Empresa › Local › Grupo, mosaico 1/4/9/16, tela cheia, foco numa câmera (duplo clique ou clique na árvore), pausa, som, captura de imagem. "Automático" tenta **WebRTC** (menor atraso) e, se não conectar, usa **HLS**. O ícone de monitor na lista de Câmeras abre a câmera ao vivo.
- **Segurança do ao vivo:** o navegador recebe só um endereço temporário `/live/<token>/…` (2 h), ligado ao usuário, à sessão e à câmera. A chave RTMP e o caminho interno nunca chegam ao navegador. O gateway reconfere o acesso a cada pedido (cache de 5 s); no WebRTC, o worker encerra a cada 10 s as conexões cujo acesso foi retirado (logout, usuário ou cliente desativado, permissão ou câmera retirada). Abrir o ao vivo fica na auditoria (um registro por usuário e câmera a cada 30 min).
- **Sessão:** token de acesso de 15 min em memória e renovação por cookie httpOnly (30 dias), trocado a cada uso. Login bloqueia 15 min após 5 erros no mesmo e-mail (ou 20 no mesmo IP).

## Operação

```bash
# câmeras e estados
docker compose exec api node apps/api/dist/cli.js camera:list

# dados para configurar a câmera (servidor + chave)
docker compose exec api node apps/api/dist/cli.js camera:show-key --tenant empresa-alfa --code CAM-001

# trocar a chave (a antiga para de funcionar e quem a usa é desconectado)
docker compose exec api node apps/api/dist/cli.js camera:rotate-key --tenant empresa-alfa --code CAM-004

# eventos recentes
docker compose exec postgres psql -U topcam_owner -d topcam -c \
  "SELECT occurred_at, type, severity, message FROM camera_events ORDER BY id DESC LIMIT 20"

# logs
docker compose logs -f api worker mediamtx web

# recuperar acesso (ex.: único administrador bloqueado): senha temporária, troca obrigatória
docker compose exec api node apps/api/dist/cli.js user:reset-password --email voce@dominio.com.br
docker compose exec api node apps/api/dist/cli.js user:create --email x@y --name "Nome" --role platform_admin
docker compose exec api node apps/api/dist/cli.js user:disable --email x@y
docker compose exec api node apps/api/dist/cli.js user:delete --email x@y
```

Toda exibição e troca de chave fica registrada em `audit_logs`.

### Configurar uma câmera (RTMP push)

Na interface da câmera, procure a opção RTMP (às vezes chamada de "Live", "Plataforma" ou "Stream"):

- **Servidor/URL:** `rtmp://<PUBLIC_HOST>:1935/live`
- **Chave (stream key):** a chave de 40 caracteres exibida no painel (Câmeras → câmera → "Exibir dados de configuração") ou por `camera:show-key`
- Se houver um campo único de URL: `rtmp://<PUBLIC_HOST>:1935/live/<CHAVE>`
- Recomendado: **H.264**, áudio **AAC** (ou desligado), GOP de 2 s, 1–2 Mbps.

Para validar a TWG 6608, siga `docs/procedimento-teste-twg6608.md`.

### Transmissor de teste

Simula uma câmera sem o equipamento físico:

```bash
KEY=$(docker compose exec -T api node apps/api/dist/cli.js camera:show-key --tenant empresa-alfa --code CAM-001 --raw)
docker compose --profile test run -d --rm --name tx-cam1 test-transmitter publish "$KEY" CAM-001
docker rm -f tx-cam1        # derruba (simula queda)
```

Para mudar a resolução, a taxa de quadros e o bitrate, use as variáveis `TX_SIZE`, `TX_FPS` e `TX_BITRATE` no `.env`. Com `TX_CLOCK=1`, o transmissor desenha no topo do vídeo uma faixa com o relógio (usada para medir a latência no navegador).

---

## Desenvolvimento

Requer Node 22 e pnpm 10.

```bash
pnpm install
pnpm build
pnpm lint
pnpm test               # unitários + integração
```

Os testes de integração precisam de um Postgres e de um Redis (`TEST_ADMIN_DATABASE_URL` e `TEST_REDIS_URL`). A forma mais simples é rodar dentro do Compose:

```bash
docker compose --profile test run --rm tests
```

### Testes do painel (E2E)

Playwright abre o painel em 1440 px (computador), 768 px (tablet) e 390 px (celular), executa o fluxo do administrador e do visualizador e salva capturas em `reports/screens/`. Rode de uma máquina com Node 22 que alcance o painel:

```bash
pnpm install && pnpm exec playwright install chromium
E2E_BASE_URL=http://<PUBLIC_HOST> E2E_ADMIN_EMAIL=<ADMIN_EMAIL> \
E2E_ADMIN_NEW_PASSWORD='<senha atual do admin>' pnpm exec playwright test
```

**Ao vivo (E2E):** com as 5 câmeras da Empresa Alfa transmitindo (`scripts/accept-phase3.sh --keep-tx`), acrescente `E2E_LIVE=1`. É preciso um navegador com H.264 — o Chromium do Playwright não tem o codec; use o Google Chrome com `PW_CHROMIUM_PATH=/usr/bin/google-chrome` (ou o caminho no seu sistema). O teste mede a latência de ponta a ponta lendo, na tela, o relógio que o transmissor desenha no vídeo da CAM-001 (`TX_CLOCK=1`) e grava o resultado em `reports/latencia-ao-vivo.json`.

Se o administrador ainda estiver no primeiro acesso, informe também `E2E_ADMIN_PASSWORD=<ADMIN_INITIAL_PASSWORD>`: o teste faz a troca pela tela, definindo a senha de `E2E_ADMIN_NEW_PASSWORD`. Use um ambiente de teste: o fluxo cria clientes e usuários fictícios.

### Estrutura

```
apps/api        API (Fastify) — login, cadastros, permissões, auditoria, hooks do MediaMTX, CLI
apps/web        painel (Next.js 16 + Tailwind 4), responsivo
e2e/            testes de ponta a ponta do painel (Playwright)
apps/worker     tarefas duráveis, validação, reconciliação, monitoramento
packages/db     migrations SQL (modelo completo + RLS), seed, repositório
packages/shared estados, chaves, caminhos, cliente da API do MediaMTX
infra/          mediamtx, caddy, preparo da VM
tools/          transmissor RTMP de teste
scripts/        geração do .env e testes de aceite por fase
docs/           especificação, plano, procedimentos
```

### Migrations

Os arquivos ficam em `packages/db/migrations/NNNN_nome.sql`. Cada um roda uma vez, numa transação, com checksum conferido.

- **Nunca altere uma migration já aplicada:** crie uma nova.
- Toda tabela com `tenant_id` deve ter RLS. Um teste de integração falha se alguma não tiver.
