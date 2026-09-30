# Fase 8 — Segurança, backup e resiliência

Entregue em partes. Este documento é atualizado a cada parte.

| Parte | Conteúdo | Situação |
|---|---|---|
| 1 | HTTPS (Let's Encrypt), RTMPS, firewall editável no painel | **aprovada na VM em 30/09/2026** (RTMPS pronto, ainda desligado) |
| 2 | Limite de requisições (rate limit) e rotação de segredos com recriptografia | **implementada e testada no laboratório; aguardando aplicação na VM** |
| 3 | Backup remoto configurável no painel (SFTP/FTPS/FTP, cifrado) | a fazer |
| 4 | Restauração em VM limpa, testes de reinício, relatório de 7 dias, aceite | a fazer |

---

## Parte 1 — HTTPS, RTMPS e firewall

### O que foi feito

**HTTPS do painel**

- **Gateway (Caddy):** um único bloco de configuração, usado em dois modos:
  - Laboratório (`SITE_ADDRESS=:80`): HTTP, como antes.
  - Produção (`SITE_ADDRESS=topcam.suportinet.com.br`):
    - certificado Let's Encrypt emitido e renovado sozinho;
    - qualquer `http://` (inclusive pelo IP) é redirecionado para `https://<domínio>`;
    - cabeçalho HSTS.
- **Porta interna `:8080`:** só dentro da rede do Docker. Serve a verificação de saúde do gateway e os roteiros de aceite (`BASE=http://gateway:8080`), que assim funcionam igual com ou sem HTTPS.
- **`scripts/https.sh --domain <domínio>`:**
  - confere o DNS;
  - ajusta o `.env`: `PUBLIC_HOST`, `SITE_ADDRESS`, redirecionamento, `PANEL_URL=https://…`, `COOKIE_SECURE=true` e `WEBRTC_HOSTS` (domínio + IP interno);
  - guarda cópia do `.env` anterior;
  - recria os serviços e aguarda o certificado.
- **Desfazer:** `scripts/https.sh --off` volta para HTTP.

**RTMPS (porta 1936)**

- O servidor de mídia aceita RTMP (1935) e RTMPS (1936) ao mesmo tempo: `RTMP_ENCRYPTION=optional`.
- **Certificado:** é o mesmo do painel, copiado pelo serviço do host para `.data/tls` (dono 1000, chave 0600).
- **Renovação:** o servidor de mídia é reiniciado entre 03:00 e 05:00.
- **Padrão:** RTMPS desligado (`no`). Liga com `scripts/https.sh --rtmps on`, que recusa se o certificado ainda não tiver sido copiado.
- **TWG 6608:** o suporte a RTMPS não é conhecido. As câmeras continuam em RTMP na 1935 sem mudança.

**Firewall editável no painel (Configurações → Firewall do servidor, só Super Admin)**

- **Na tela:** a lista de redes que podem acessar o SSH (IP/máscara + descrição), com adicionar, editar e remover.
  - Status da aplicação: aplicado, aguardando, erro, serviço parado ou não instalado.
  - Portas públicas mostradas só para consulta.
- **Validação:**
  - máscara mínima /8 (IPv6 /16);
  - IP com bits de host é normalizado (`172.31.141.20/16` → `172.31.0.0/16`);
  - IP sem máscara vira /32;
  - rede repetida é recusada;
  - **a última rede não pode ser removida.**
- **Auditoria:** `firewall.rule_created`, `firewall.rule_updated` e `firewall.rule_deleted`.
- **Quem aplica:** o **serviço do host** `topcam-host`, que roda no Debian fora do Docker, com um timer de 1 minuto. Nenhum contêiner tem permissão sobre o firewall.
  - Lê a lista no banco, valida de novo e aplica tudo de uma vez numa tabela própria `inet topcam_fw` (confere com `nft -c` antes). Não toca nas regras do Docker.
  - Entrada bloqueada por padrão. Liberados: conexões já estabelecidas, loopback, redes do Docker, ICMP, SSH só das redes da lista, e 80, 443, 1935, 1936 e 8189 (tcp e udp).
  - Lista vazia/inválida ou banco fora do ar: **mantém as regras atuais**.
  - Depois de reiniciar a VM: restaura as últimas regras antes mesmo de o banco subir.
- **Proteções contra ficar trancado para fora:**
  1. A instalação recusa se a sua sessão SSH atual não estiver nas redes informadas.
  2. A instalação desfaz tudo sozinha em 120 s se você não confirmar, depois de abrir **uma nova sessão SSH**.
  3. `topcam-host reset` volta às redes da instalação, e `topcam-host disable` remove o firewall e para o serviço.
  4. O console do Proxmox não passa por este firewall.
- **Firewall antigo do `prepare-vm.sh --firewall`** (com `flush ruleset`): foi substituído. A instalação o remove se existir e guarda uma cópia.

### Arquivos

- `infra/caddy/Caddyfile`, `compose.yaml`, `.env.example`
- `packages/db/migrations/0008_fase8_firewall.sql` — tabela `firewall_ssh_networks` (só plataforma, via RLS)
- `apps/api/src/routes/firewall.ts`, `apps/web/components/firewall-card.tsx`, `apps/web/app/(painel)/configuracoes/page.tsx`
- `scripts/host/topcam-host` — serviço do host: `install`, `sync`, `apply`, `status`, `reset`, `disable`, `enable`, `render`
- `scripts/https.sh`
- `infra/vm/prepare-vm.sh` — `--firewall` agora só orienta
- `scripts/accept-phase2..7` — `BASE=http://gateway:8080`
- Testes: `apps/api/test/firewall.int.test.ts` (7) e `e2e/firewall.spec.ts`

### Testes no laboratório

| Teste | Resultado |
|---|---|
| Testes automatizados | 178/178 (7 novos do firewall) |
| E2E | 40/40 (firewall nos 3 tamanhos de tela) |
| Lint, tipos, formatação | ok |
| Modo HTTP (padrão) | painel 200; saúde interna 8080 ok; servidor de mídia sobe sem certificado e sem RTMPS |
| Modo HTTPS (`SITE_ADDRESS=localhost`, certificado interno do Caddy) | `https://` 200 com HSTS; `http://127.0.0.1` → 301 `https://localhost/…`; `http://localhost` → 308; cookie seguro |
| RTMPS | handshake TLS 1.3 na 1936; chave inválida recusada (401); **publicação com chave válida aceita por RTMPS** |
| Firewall — regras | `nft -c` ok (IPv4 e IPv6); regras aplicadas de verdade; o painel continua respondendo |
| Firewall — lista vazia | não aplica e mantém as regras; status "erro" no painel |
| Firewall — sem mudança | não reaplica |
| Firewall — reinício simulado com o banco fora | últimas regras restauradas |
| Instalação | recusa sessão de fora das redes; recusa 0.0.0.0/0 |
| `reset` / `disable` | ok |
| Certificado do RTMPS | copiado com dono 1000 e chave 0600 |
| Aceite Fase 7 pelo endereço interno | 9/9 |

**Não testado aqui** (depende da VM e da internet):

- emissão real do Let's Encrypt para `topcam.suportinet.com.br`;
- timer do systemd;
- confirmação por nova sessão SSH.

Estes pontos são validados no procedimento abaixo.

### Correção após a primeira tentativa na VM

- **Sintoma:** o `topcam-host install` e o `topcam-host status` travavam num terminal SSH, logo após "redes da instalação". Nada era aplicado.
- **Causa:** o `timeout` tira o `docker compose exec` do primeiro plano do terminal, e ele fica parado esperando o teclado. No teste automatizado não havia terminal.
- **Correção:** as consultas agora recebem a entrada de `/dev/null`.
- **Reteste com terminal simulado:** install completo, status e confirmação `OK`.
- **Timer:** se ele não ligar, o install agora avisa em vez de ficar calado.

- **Segunda correção:** na VM a confirmação `OK` não era recebida pela janela 1, embora a nova sessão entrasse. Agora:
  - a confirmação pode ser feita **pela própria sessão nova**, com `topcam-host confirmar`;
  - na janela 1, a resposta é lida direto do terminal e aceita `ok` em maiúsculas ou minúsculas, com ou sem espaços, além de `sim`;
  - o que foi recebido aparece na tela;
  - reverter também apaga as regras salvas.

### Validação na VM (30/09/2026)

| Item | Resultado |
|---|---|
| IP 45.237.164.6 na loopback | adicionado e gravado em `/etc/network/interfaces.d/topcam-ip-publico` |
| DNS e porta 80 | `topcam.suportinet.com.br` → 45.237.164.6; porta 80 acessível pelo 4G |
| HTTPS | certificado Let's Encrypt (YE1) emitido, válido até 29/12/2026; cookie seguro |
| Painel e vídeo ao vivo por HTTPS | ok (WebRTC com domínio + 172.31.141.20) |
| Firewall | instalado; nova sessão SSH entrou e confirmou; 4 redes aplicadas; status "ok" |
| Timer | ativo; roda a cada 1 min |
| Certificado do RTMPS | copiado para `.data/tls` às 12:42:57 |

### Procedimento na VM (em ordem)

1. **Atualizar** com o bundle, como sempre (`scripts/update.sh --bundle …`). A migração 0008 roda sozinha, e o painel continua em HTTP.
2. **Antes do HTTPS**, conferir que as portas **80 e 443 de 45.237.164.6** chegam na VM a partir da internet. O Let's Encrypt valida por elas.
3. **HTTPS:**
   ```
   scripts/https.sh --domain topcam.suportinet.com.br --webrtc-host 172.31.141.20
   ```
   Acesse `https://topcam.suportinet.com.br` e faça login de novo.
4. **Firewall** (como root, numa sessão SSH vinda de uma das redes):
   ```
   scripts/host/topcam-host install --ssh 172.31.0.0/16 --ssh 100.65.0.0/21 --ssh 100.66.0.0/21 --ssh 45.237.164.0/22
   ```
   Abra **outra** sessão SSH. Se entrar, rode nela `topcam-host confirmar`, em até 120 s.
5. **RTMPS** (opcional, cerca de 1 min depois do passo 3):
   ```
   scripts/https.sh --rtmps on
   ```
6. **Conferir:**
   - `scripts/https.sh --status`;
   - `topcam-host status`;
   - Configurações → Firewall do servidor mostra "Aplicado no servidor".

**Se perder o SSH:** entre pelo console do Proxmox (VM 107) e rode `topcam-host reset` ou `topcam-host disable`.

---

## Parte 2 — Limite de requisições e rotação de segredos

### Limite de requisições

**Geral, por IP**

- Vale para `/api/*`: 1200 requisições por minuto por IP (`RATE_LIMIT_API_PER_MIN`; 0 desliga).
- **Ficam de fora:**
  - `/api/v1/health` e as rotas internas `/internal/*` (servidor de mídia e gateway);
  - loopback e `172.16.0.0/12` (rede interna 172.31.x e redes do Docker);
  - as redes cadastradas em Configurações → Firewall. A lista é relida a cada minuto.
- **Ao estourar:**
  - resposta 429 "Muitas solicitações deste endereço. Aguarde N segundos…", com `Retry-After`;
  - um evento "Limite de requisições" na tela Eventos, no máximo um a cada 10 minutos por IP.

**Por ação sensível**

A chave do limite é o usuário logado; sem login, o IP.

| Ação | Limite |
|---|---|
| Renovação de sessão | 300/min por IP; redes confiáveis ficam de fora |
| Troca da própria senha | 10 a cada 15 min |
| Alterar senha / enviar acesso | 30 por hora |
| Cadastro de usuário | 120 por hora |
| Exibir chave de câmera | 60 a cada 10 min |
| Trocar chave de câmera | 30 a cada 10 min |
| E-mail de teste | 10 a cada 10 min |

O login mantém o limite que já existia: 5 tentativas por e-mail e 20 por IP.

**Chave de câmera errada**

- **Quando bloqueia:** depois de 20 chaves ou caminhos errados em 10 minutos, vindos do mesmo IP (`PUBLISH_BADKEY_MAX`).
- **O que o bloqueio faz:** por 30 minutos (`PUBLISH_BADKEY_BLOCK_S`), as tentativas erradas desse IP são recusadas sem gravar eventos.
- **O que fica registrado:** um evento "IP bloqueado (chaves erradas)" e um alerta `security.publish_ip_blocked:<ip>`, resolvido manualmente na tela Alertas.
- **Câmeras não são afetadas:** câmeras com a chave certa, mesmo atrás do mesmo IP (CGNAT), continuam entrando. O bloqueio só atua quando a chave não confere.

### Rotação de segredos

`scripts/rotate-secrets.sh` troca os segredos por grupo:

| Grupo | Segredos | Efeito |
|---|---|---|
| `--jwt` | `JWT_SECRET` | logins continuam (as sessões não dependem dele); quem estiver vendo ao vivo ou gravação reabre o vídeo |
| `--media` | `MEDIA_HOOK_SECRET`, `MEDIA_READ_PASSWORD`, `MEDIA_GATEWAY_TOKEN` | o servidor de mídia reinicia; câmeras reconectam em segundos |
| `--db` | `POSTGRES_PASSWORD`, `APP_DB_PASSWORD` | o banco reinicia (alguns segundos) |
| `--enc` | `STREAM_KEY_ENC_KEY` | recifra no banco as chaves das câmeras (inclusive excluídas/transferidas) e a senha do SMTP |

`--all` troca os quatro grupos.

**Segurança da troca:**

- Guarda cópia do `.env` antes (`.env.antes-rotacao.<data>`, só root lê). Ao final, pede para apagá-la depois de conferir.
- Os segredos nunca aparecem na tela nem na linha de comando: as chaves vão pelo stdin. A auditoria (`secrets.rotated`, `secrets.reencrypted`) registra só os grupos.
- **Recifragem (`--enc`):**
  - roda numa transação única, com o worker parado;
  - antes de mexer no banco, a chave nova é guardada em `.env.rotacao-pendente`;
  - se algo falhar, tudo é desfeito, inclusive a senha do dono do banco, e o `.env` não muda;
  - repetir é seguro: o que já está na chave nova fica como está.
- **Conferência:** no final, `secrets:check` confirma que todas as chaves abrem com a chave nova.
- **As chaves RTMP das câmeras não mudam.** A troca delas continua sendo câmera por câmera, no painel.

Novos comandos da CLI da API: `secrets:reencrypt`, `secrets:check` e `secrets:rotated`.

### Arquivos

- `apps/api/src/plugins/ratelimit.ts` (novo), `apps/api/src/lib/ratelimit.ts`
- `apps/api/src/routes/mediamtx.ts` — bloqueio por chave errada
- rotas com limite: `auth.ts`, `users.ts`, `cameras.ts`, `integrations.ts`
- `apps/api/src/env.ts`, `compose.yaml`, `.env.example` — `RATE_LIMIT_API_PER_MIN`, `PUBLISH_BADKEY_MAX`, `PUBLISH_BADKEY_BLOCK_S`
- `packages/db/src/secrets.ts` (novo) — `reencryptSecrets`
- `apps/api/src/cli.ts` — `secrets:*`
- `scripts/rotate-secrets.sh` (novo)
- `packages/shared/src/events.ts`, `apps/web/lib/format.ts` — eventos `rate_limited` e `publish_ip_blocked`
- Testes: `apps/api/test/ratelimit.int.test.ts` (6) e `apps/api/test/secrets.int.test.ts` (4)
- E2E: `e2e/clientes-usuarios.spec.ts` agora pesquisa pelo e-mail (a lista paginada falhava com dados acumulados)

### Testes no laboratório

| Teste | Resultado |
|---|---|
| Testes automatizados | 188/188 (10 novos) |
| E2E | 40/40 |
| Lint, tipos, formatação | ok |
| Aceite Fase 2 (login, sessões, permissões) | 12/12 |
| Limite geral | 429 em português com Retry-After; um evento só; outro IP não é afetado; health, rede interna, loopback e redes do firewall não são limitados |
| Limite por ação | troca de senha: 11ª tentativa → 429 |
| Chave errada | 3 erros (limite de teste) → bloqueio, evento e alerta; tentativas seguintes não gravam eventos; câmera com chave certa no mesmo IP entra (200); outro IP não é afetado |
| Recifragem | chave errada → erro e nada muda; recifra todas as câmeras (inclusive excluídas) e o SMTP; repetir é seguro |
| `rotate-secrets.sh --all` no ambiente completo | 29 s, todos os serviços saudáveis |
| Depois da troca | os 7 segredos mudaram; 47 chaves legíveis; token antigo → 401; a sessão antiga renova (200); a mesma chave de câmera no painel; a câmera publicou com a mesma chave e ficou ao vivo; senhas antigas do banco recusadas e novas aceitas pela rede; auditoria só com os grupos |
| Falha simulada (`--db --enc` com chave errada no `.env`) | recifragem desfeita, senha do dono revertida, `.env` intacto, worker religado |

### Procedimento na VM (parte 2)

1. Atualizar com o bundle (`scripts/update.sh --bundle …`). Os limites passam a valer na hora.
2. Conferir o painel normalmente, pela rede interna e pelo 4G.
3. **Rotação** (recomendada uma vez agora, porque os segredos atuais passaram por testes e cópias):
   ```
   scripts/rotate-secrets.sh --all
   ```
   Digite `SIM` para confirmar. Leva cerca de 30 s. Depois:
   - confira painel, ao vivo e câmeras;
   - apague a cópia com `rm .env.antes-rotacao.*`.
