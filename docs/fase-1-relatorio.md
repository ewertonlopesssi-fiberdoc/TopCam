# TopCam — Relatório da Fase 1 (fundação e ingestão RTMP autenticada)

26/09/2026 · commits `526a691` e `ab46d13` · **aceite: 11/11 critérios aprovados**, com o ambiente Docker Compose real e 5 transmissores RTMP de teste.

## O que foi entregue

| Área | Entrega |
|---|---|
| Estrutura | Monorepo pnpm/TypeScript: `apps/api`, `apps/worker`, `packages/db`, `packages/shared`. Uma imagem Docker para a aplicação |
| Banco | Modelo de dados **completo da versão final**: 19 tabelas, incluindo gravação, exportação, alertas, sessões, planos e nós de ingestão/armazenamento. RLS em todas as tabelas de negócio, FKs compostas `(id, tenant_id)`, auditoria só de inserção e tarefas duráveis |
| Migrations | SQL versionado, cada arquivo numa transação, com checksum e advisory lock. O papel `topcam_app` não tem SUPERUSER nem BYPASSRLS |
| Seed | Idempotente: 3 planos, 5 papéis, retenção de 24 h, nós de ingestão/armazenamento, administrador inicial e 2 clientes fictícios. A **Empresa Alfa** tem CAM-001 (gravação habilitada) e CAM-002..005 (só ao vivo). O **Condomínio Sol** tem 1 câmera |
| Chaves RTMP | 40 caracteres (~238 bits). Hash SHA-256 para busca e cópia AES-256-GCM para exibição. Rotação via CLI, com auditoria |
| API | Autenticação HTTP do MediaMTX, que confere chave, câmera ativa, cliente ativo, protocolo RTMP e publicação duplicada. Hooks online/offline, eventos com IP de origem e supressão de repetições. `/health`, `/ready`, `/api/v1/health` |
| Worker | Fila durável no PostgreSQL (acordada via Redis) com 4 tarefas em paralelo. Validação por ffprobe (codec, resolução, fps, avisos de H.265 e áudio). Reconciliação dos relays `cam/<id>`, desconexão de chaves inválidas, poller de estado/bitrate/queda e alerta de servidor de mídia fora do ar |
| Infra | `compose.yaml` com health checks, logs rotativos, volumes nomeados e só as portas 80 e 1935 publicadas. MediaMTX 1.21.1, Caddy, `prepare-vm.sh` (Docker e disco de vídeo) e `generate-env.sh` |
| Testes | 55 testes automatizados (19 unitários, 36 de integração com Postgres e Redis reais) e o aceite `scripts/accept-phase1.sh` |
| Documentos | `README.md` (instalação, operação, configuração de câmera) e `docs/procedimento-teste-twg6608.md` |

## Resultado do aceite

Evidência completa: `docs/evidencias/aceite-fase1-20260926.md` e o log dos testes.

| # | Critério | Resultado |
|---|---|---|
| 1 | Serviços saudáveis em ≤ 2 min | ✅ 11 s após o `up` |
| 2 | Migrations do zero e idempotentes | ✅ 2ª execução: 0 aplicadas; esquema idêntico |
| 3 | 5 câmeras em `ao_vivo` em ≤ 15 s, com codec/resolução/fps | ✅ 6–7 s cada (H.264 640x360 15 fps) |
| 4 | Chave inválida recusada, com evento e IP | ✅ |
| 5 | Publicação duplicada recusada, original intacta | ✅ mesma conexão antes e depois |
| 6 | Queda → offline em ≤ 15 s; volta → ao vivo | ✅ offline em 1 s; de volta em 6 s |
| 7 | 10 min com 5 transmissões: 0 arquivos, 0 segmentos | ✅ |
| 8 | Isolamento Sol × Alfa (RLS), mesmo sem filtro | ✅ |
| 9 | Rotação: chave antiga recusada, nova aceita, mesmo ID | ✅ publicador antigo desconectado em 1 s |
| 10 | Reinício da API sem queda; reinício do MediaMTX se recupera | ✅ 5/5 conexões intactas; recuperação em 12 s |
| 11 | Testes e lint | ✅ 55/55 |

## Problemas encontrados e corrigidos durante a fase

1. **O MediaMTX exige `%path` no diretório de gravação.** Com `live/<chave>`, a chave apareceria nos nomes de arquivo.
   - **Solução:** relay interno `cam/<id da câmera>`, sem transcodificação, que lê `live/<chave>`.
   - **Efeito:** gravação (Fase 4) e visualização (Fase 3) usam o ID da câmera. A chave não aparece em arquivos nem em URLs, e trocar a chave não quebra o histórico.
2. **Consultar a API do MediaMTX dentro da autenticação travava por 3 s** (o MediaMTX espera a resposta da autenticação antes de atender a consulta).
   - **Solução:** a detecção de publicação duplicada passou a usar o estado no banco (vídeo recente ou autorização recente). `overridePublisher: false` continua como segunda barreira.
3. **Configurar `live/<chave>` via API reiniciava o caminho** e derrubava a câmera depois de um reinício do MediaMTX.
   - **Solução:** a entrada usa só os padrões do `mediamtx.yml`. O worker gerencia apenas os relays `cam/<id>`.
   - **Efeito:** a recuperação caiu de 26 s para 12 s, sem recusas indevidas.
4. **Na rotação de chave, a câmera ficava `ao_vivo` até o poller perceber.**
   - **Solução:** a rotação encerra o estado na hora (vai para `offline`), e a chave nova é aceita imediatamente.

## Mudanças em relação ao plano

| Plano | Implementado | Motivo |
|---|---|---|
| Kysely para consultas | SQL direto com `pg` | Deixa as políticas de RLS e as consultas explícitas, com uma dependência a menos |
| argon2id para senhas | scrypt nativo do Node (N=32768, r=8, p=1) | Sem módulo nativo compilado na imagem. O parâmetro fica gravado no hash, então dá para migrar depois |
| `infra/compose/` | `compose.yaml` na raiz | Permite rodar `docker compose up` direto na pasta do projeto |
| Caminho único `live/<chave>` | `live/<chave>` (entrada) + `cam/<id>` (relay) | Problema 1 acima |
| Prometheus na Fase 1 (tabela de serviços) | Fica para a Fase 7 | Não fazia parte dos critérios da Fase 1 |

## O que NÃO foi testado aqui (e como validar)

| Item | Situação | Como validar |
|---|---|---|
| VM Debian real no Proxmox | Testado em Linux 6.18 / Docker 29.4 no ambiente em nuvem | Na VM: `scripts/accept-phase1.sh`. O relatório sai em `reports/` |
| `prepare-vm.sh`: instalação do Docker e firewall | Não executados aqui | Rodar na VM nova. Conferir com `docker compose version` e `nft list ruleset` |
| `prepare-vm.sh`: disco de vídeo | ✅ Testado com disco virtual (loop) em Debian 13: disco vazio, já formatado, já montado, disco com dados (recusa) e `--force-format` | — |
| Câmera TWG 6608 | Sem acesso ao equipamento | `docs/procedimento-teste-twg6608.md` |
| Resolução e bitrate reais | O aceite usou 640x360, 15 fps, 800 kbps, por limite de CPU do ambiente de teste | Na VM: `TX_SIZE=1920x1080 TX_FPS=25 TX_BITRATE=2M scripts/accept-phase1.sh --no-build` |
| Push para o GitHub | Sem acesso à conta daqui | Comandos na seção abaixo |

## Pendências e observações

- **Administrador inicial:** é criado com `must_change_password`. O login chega na Fase 2.
- **Janela de publicação ativa (12 s):** logo após uma queda brusca da câmera (sem aviso do MediaMTX), a reconexão pode ser recusada como "duplicada" por até cerca de 10 s, até o poller marcar a câmera `offline`. A câmera tenta de novo sozinha. É o mesmo comportamento do próprio MediaMTX (`readTimeout` de 10 s).
- **HTTP sem TLS e RTMP sem RTMPS no laboratório:** entram na Fase 8, com o domínio definitivo (D4).
- **Segredo dos hooks:** vai na URL interna entre MediaMTX e API. Essa rede não é exposta e o log da API remove a query string.

## Enviar para o GitHub

```bash
# no computador onde está a pasta TopCam (com git instalado)
cd TopCam/topcam
git remote add origin https://github.com/ewertonlopesssi-fiberdoc/TopCam.git
git push -u origin main
```

Antes, crie o repositório **TopCam** vazio e privado no GitHub, sem README.

## Próxima fase (2): autenticação, multiempresa e cadastros + base visual

Login (JWT + refresh), papéis, permissões por câmera, auditoria e as telas Clientes, Usuários, Grupos/Locais, Câmeras (cadastro individual com geração e rotação de chave) e Configurações, seguindo o layout das imagens de referência e responsivas.
