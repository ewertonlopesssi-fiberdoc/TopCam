# Fase 9.3: notificações push dos alarmes (02/10/2026)

**Situação**

- Servidor e app prontos e testados no laboratório, com um serviço de push falso no lugar do da Expo.
- Para chegar no celular de verdade, faltam as contas e as chaves que só o Ewe pode criar: projeto na Expo e Firebase. O passo a passo está abaixo.
- A parte do servidor (migration 0012, API e worker) vai para a produção **depois do relatório de 7 dias** (08/10, a partir de 14:52), junto com a parte do servidor da 9.2.

## Como funciona

1. **Ao abrir o app logado:**
   - o app pede permissão de notificação;
   - pega o endereço de push do celular (serviço da Expo);
   - registra no servidor, ligado ao usuário e à sessão.
2. **Quando o alarme de uma câmera dispara** (mesma decisão do e-mail: alarme ligado, horário, intervalo mínimo):
   - o worker manda o push para os celulares dos usuários do cliente com acesso à câmera;
   - o e-mail continua, se estiver ligado na câmera;
   - se o e-mail estiver desligado, vai só o push.
3. **A notificação:**
   - "Movimento detectado: Portão Social", com o local e o horário;
   - som e prioridade alta;
   - no Android, no canal **Alarmes das câmeras**.
4. **Tocar na notificação:**
   - quem pode reproduzir vai para a **gravação no horário**;
   - quem só vê ao vivo vai para o **ao vivo**;
   - funciona com o app aberto, em segundo plano ou fechado.
5. **Conta → Notificações de alarme:**
   - ligar e desligar neste celular;
   - **Enviar notificação de teste**.
6. **Quem não recebe:**
   - **Sair do app** tira o celular da conta, e a sessão encerrada não recebe mais.
   - Usuário desativado ou sem acesso à câmera não recebe.
7. **Celular que desinstalou o app:**
   - o serviço de push avisa ("DeviceNotRegistered") na hora ou no recibo, conferido de 15 min a 24 h depois;
   - o servidor desliga o token sozinho.

## Servidor

| Item | Detalhe |
|---|---|
| `0012_push.sql` (aditiva) | Tabela `push_devices`: token, usuário, cliente, sessão, plataforma, marca, aparelho, versão, ligado/desligado, último envio e erro. RLS por cliente. `alarm_notifications` ganha `push_device_id`, `push_ticket` e `receipt_checked_at` |
| `POST /api/v1/push/devices` | Registra ou atualiza o celular do usuário logado. Se o mesmo celular trocar de conta, passa para a conta nova. Audita só quando muda (ligou, desligou, outra conta); o token não vai para a auditoria |
| `DELETE /api/v1/push/devices` | Remove o celular; só o dono consegue |
| `POST /api/v1/push/test` | Teste para os próprios celulares (no máximo 5 a cada 5 min) |
| Worker `processAlarms` | E-mail + push na mesma decisão; registra cada envio em `alarm_notifications` (canal `push`, com o ticket) |
| Worker `push-receipts` (5 min) | Confere os recibos e desliga os tokens mortos |
| `.env` | `EXPO_ACCESS_TOKEN` (opcional: só se a "segurança de push" for ligada na conta Expo). `EXPO_PUSH_URL` vazio = serviço da Expo |
| `packages/shared/src/push.ts` | Cliente do serviço de push da Expo (lotes de 100, erros, recibos) |

## App

- `expo-notifications`, `expo-device` e `expo-constants`.
- `src/lib/push.ts` (registro e situação), `src/lib/push-route.ts` (para onde o toque leva) e `src/components/push-bridge.tsx` (registro ao abrir e toque na notificação).
- Cartão **Notificações de alarme** em Conta.
- `app.config.ts`:
  - plugin de notificações (ícone e cor da marca, canal "alarmes");
  - `easProjectId` do `brand.json`;
  - `brands/<marca>/google-services.json` (Firebase), quando existir.
- White label: cada marca tem o seu projeto Expo e o seu Firebase. Sem eles, o app funciona e mostra "As notificações ainda não foram configuradas nesta versão do app".

## Testes

| Teste | Resultado |
|---|---|
| Suíte completa | **283/283** |
| Cliente do push (`shared`) | 4: formato do token, lotes de 100 com o token de acesso, serviço fora do ar sem derrubar o alarme, recibos |
| API (`push.int.test.ts`) | 6: login obrigatório e token válido; registro ligado à sessão sem duplicar auditoria; token fora da auditoria; teste só para os próprios celulares; desligar; outra conta no mesmo celular; só o dono remove; sair do app = sem push |
| Worker (alarme) | 3 novos: só push com e-mail desligado (sessão encerrada, desligado e sem acesso não recebem; quem não pode reproduzir abre o ao vivo); e-mail + push com token morto desligado na hora; recibos |
| App | 13/13 (toque → gravação ou ao vivo) |
| Laboratório, ponta a ponta nos contêineres | Migration 0012 aplicada sobre o banco existente. Câmera mandou o e-mail de movimento (SMTP 2525) → movimento → alarme → worker enviou o push ao serviço falso, com o token de acesso → `alarm_notifications` "push / sent" com o ticket. Notificação de teste pela API também chegou |
| E2E do app (web) | 9.1, 9.2 e WebRTC passando |

**Não testado:** a entrega real no celular. Depende da configuração abaixo e do APK 0.3.0.

## O que o Ewe precisa fazer (uma vez)

**1. Projeto na Expo** (conta que já existe, a do Expo Go)

1. No PowerShell, na pasta do `topcam-mobile` descompactado: `npx eas-cli@latest login` e depois `npx eas-cli@latest init`.
2. Ele cria o projeto "topcam" na sua conta e mostra o **ID do projeto** (um UUID).
3. Mande o ID para mim. Não é segredo.

**2. Firebase** (Android)

1. Em console.firebase.google.com: **Criar projeto** "TopCam". O Google Analytics não é necessário.
2. **Adicionar app → Android**, com o pacote `br.com.suportinet.topcam`.
3. Baixe o **google-services.json** e mande para mim. Ele vai dentro do APK, não é segredo.

**3. Chave do Firebase na Expo** (essa é secreta: **não mande para mim**)

1. Firebase → ⚙ Configurações do projeto → **Contas de serviço** → **Gerar nova chave privada** (baixa um .json).
2. Em expo.dev → projeto topcam → **Credentials** → Android → `br.com.suportinet.topcam` → **FCM V1 service account key** → envie o .json.
3. Depois, apague o .json do computador.

**4. iPhone:** depende da conta Apple Developer. A chave de push da Apple (APNs) também é cadastrada na Expo.

## Andamento (02/10)

- Projeto Expo criado (`d639cf78-eddf-4c23-8618-fbfdde52383f`, em `brand.json`).
- Firebase `topcam-e00c2` criado; o `google-services.json` está em `brands/topcam/`.
- **APK 0.3.0** gerado (versionCode 6, sha256 `c40f0df7…22f24d6c`), com a permissão de notificação e o Firebase.
- **Falta:**
  - a chave FCM V1 enviada na Expo (Ewe);
  - a parte do servidor na produção (08/10).
- Até lá, a opção em Conta mostra "Não foi possível ligar as notificações agora", porque a produção ainda não tem `/api/v1/push`.

**Teste depois de 08/10:**

1. Abrir o app 0.3.0 e permitir as notificações.
2. Conta → **Enviar notificação de teste**.
3. Disparar um movimento numa câmera com alarme ligado e conferir que a notificação chega e abre a gravação.

## Chave de assinatura oficial do app (02/10)

- A tela de credenciais Android da Expo exige a chave de assinatura. A chave oficial (prevista para a 9.4) foi gerada agora:
  - `topcam-upload.p12`, PKCS12, RSA 4096, válida por 10 000 dias, alias `topcam-upload`;
  - SHA-256 `1A:DD:99:7D:E3:FE:65:5C:11:47:8C:8A:B7:7F:3E:B0:F8:05:2A:08:5A:BD:37:82:4C:C3:80:58:EF:C9:F8:0A`.
- O arquivo e as senhas ficam com o Ewe (pasta `TopCam\assinatura`, com cópia segura). Não vão para o repositório nem para o projeto.
- Build: `scripts/mobile-build-apk.sh` assina com ela quando recebe `TOPCAM_KEYSTORE` e `TOPCAM_KEYSTORE_PASSWORD` (`apps/mobile/scripts/apply-signing.py`). As senhas não são gravadas em arquivo.
- A partir do **0.3.1**, os APKs saem com a chave oficial. Quem tem 0.3.0 ou anterior (chave de teste) precisa **desinstalar uma vez** antes de instalar.

## Credenciais na Expo concluídas (02/10)

- `br.com.suportinet.topcam` → keystore `topcam-upload` (SHA-256 `1A:DD…F8:0A`, igual ao do APK 0.3.1).
- Chave **FCM V1**: projeto `topcam-e00c2`, chave `9426f0bd…` (nova; a `38f5c1d6…` foi exposta na conversa e deve ser apagada no Google Cloud).
- A "Google service account key for EAS Submit" (publicar na Play) fica para a 9.4.
- Pendências do Ewe:
  - apagar a chave `38f5c1d6…`;
  - ~~religar a política `iam.disableServiceAccountKeyCreation`~~ — feito (02/10, "Herdar", status Aplicada).

## Recuperação do código (21/11/2026)

- O ambiente de trabalho do desenvolvimento foi reiniciado, e a cópia local do código depois da 9.2 se perdeu.
- O código foi remontado a partir de três fontes:
  - o código da produção (1186542);
  - o pacote da 9.2 (`topcam-app92-servidor.bundle`);
  - o app 0.3.0 (`topcam-mobile-0.3.0.zip`), mais o histórico da sessão (servidor do push, script de assinatura, versão 0.3.1).
- **Conferência:**
  - suíte completa 283/283, igual à de antes;
  - lint, tipagem e formatação sem erros;
  - laboratório do zero: as 12 migrations aplicadas e os serviços saudáveis;
  - push ponta a ponta: e-mail de movimento da câmera → alarme → push no serviço falso, mais a notificação de teste pela API.
- **Produção:** a VM 107 continua em 1186542. A 9.2 e a 9.3 seguem juntas no pacote `topcam-app92-93-servidor.bundle` (1186542..main).

## Produção (21/11/2026)

- Pacote 9.2 + 9.3 aplicado na VM 107 (commit d4cddc6), com a migration 0012 e todos os serviços saudáveis. Enviado ao GitHub.
- **Notificação de teste chegou no celular** (app 0.3.1, Android).
- Falta o teste com alarme real, quando houver câmera com detecção de movimento e alarme ligados. As câmeras de teste foram retiradas.
