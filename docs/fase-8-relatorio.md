# Fase 8 — Segurança, backup e resiliência

Entregue em partes. Este documento é atualizado a cada parte.

| Parte | Conteúdo | Situação |
|---|---|---|
| 1 | HTTPS (Let's Encrypt), RTMPS, firewall editável no painel | **implementada e testada no laboratório; aguardando aplicação na VM** |
| 2 | Limite de requisições (rate limit) e rotação de segredos com recriptografia | a fazer |
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
   Abra **outra** sessão SSH. Se entrar, digite `OK` na primeira em até 120 s.
5. **RTMPS** (opcional, cerca de 1 min depois do passo 3):
   ```
   scripts/https.sh --rtmps on
   ```
6. **Conferir:**
   - `scripts/https.sh --status`;
   - `topcam-host status`;
   - Configurações → Firewall do servidor mostra "Aplicado no servidor".

**Se perder o SSH:** entre pelo console do Proxmox (VM 107) e rode `topcam-host reset` ou `topcam-host disable`.
