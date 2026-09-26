# TopCam

Plataforma multiempresa de câmeras IP: recebe câmeras por **RTMP push** (cada uma com chave exclusiva), mostra ao vivo, grava as câmeras autorizadas com retenção configurável e isola os dados de cada cliente.

O laboratório roda numa única VM Debian no Proxmox (disco de 25 GB para o sistema + 35 GB para vídeo). Todos os serviços ficam em contêineres separados, para que a migração ao servidor dedicado mude apenas configuração e escala.

> **Estado atual: Fase 1 — fundação e ingestão RTMP autenticada.** Painel web (Fase 2), ao vivo no navegador (Fase 3) e gravação (Fase 4) ainda não estão disponíveis. Veja `docs/plano-de-execucao.md`.

---

## Arquitetura (Fase 1)

```
Câmera / transmissor ──RTMP :1935──► mediamtx ──auth HTTP + hooks──► api ──► PostgreSQL (RLS)
                                        ▲                             │
                                        │ API de controle              ▼
                                        └────────── worker ◄──── Redis (acordar tarefas)
Navegador ──HTTP :80──► gateway (Caddy) ──/api/*──► api
```

| Serviço | Papel |
|---|---|
| `postgres` | Fonte da verdade. Row Level Security isola os clientes. |
| `redis` | Acorda o worker quando há tarefa nova. Tarefas críticas ficam no PostgreSQL (`durable_jobs`). |
| `migrate` | Aplica migrations e o seed idempotente e termina. |
| `api` | Autoriza cada publicação (chave, câmera, cliente, protocolo, duplicidade), recebe os hooks e expõe a saúde. |
| `worker` | Valida o vídeo (ffprobe), mantém os caminhos do MediaMTX iguais ao banco, monitora estados, bitrate e quedas. |
| `mediamtx` | Recebe RTMP. API, RTSP e HLS ficam só na rede interna. |
| `gateway` | Entrada HTTP. Bloqueia rotas internas. HTTPS com o domínio na Fase 8. |

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
   lsblk                                   # confirme o nome do disco de 35 GB (ex.: /dev/sdb)
   ./infra/vm/prepare-vm.sh --video-disk /dev/sdb
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
5. **Validar a Fase 1** com o transmissor de teste. Leva cerca de 12 minutos e gera `reports/phase1-*.md`:
   ```bash
   scripts/accept-phase1.sh
   ```

### Portas

| Porta | Uso | Exposição |
|---|---|---|
| 1935/tcp | RTMP das câmeras | Pública (ou só na rede das câmeras) |
| 80/tcp | Gateway HTTP | Pública. 443 entra na Fase 8 |
| 22/tcp | SSH | Somente rede de administração |

Postgres, Redis, API do MediaMTX, RTSP e HLS **não** são publicados.

---

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
docker compose logs -f api worker mediamtx
```

Toda exibição e troca de chave fica registrada em `audit_logs`.

### Configurar uma câmera (RTMP push)

Na interface da câmera, procure a opção RTMP (às vezes chamada de "Live", "Plataforma" ou "Stream"):

- **Servidor/URL:** `rtmp://<PUBLIC_HOST>:1935/live`
- **Chave (stream key):** a chave de 40 caracteres exibida por `camera:show-key`
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

Para mudar a resolução, a taxa de quadros e o bitrate, use as variáveis `TX_SIZE`, `TX_FPS` e `TX_BITRATE` no `.env`.

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

### Estrutura

```
apps/api        API (Fastify) — autenticação do MediaMTX, hooks, saúde, CLI
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
