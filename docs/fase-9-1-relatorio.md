# Fase 9.1: app mobile, base Android (01/10/2026)

**Situação:** pronto e testado no laboratório. O APK de teste foi gerado e aponta para a **produção** (`https://topcam.suportinet.com.br`).

- O servidor **não muda**: o app usa a API que já existe. Não há atualização para a VM 107, e o teste de 7 dias segue intacto.
- **Falta** o teste no celular real (roteiro no fim).

## Decisões aprovadas

| Item | Decisão |
|---|---|
| Etapas | 9.1 base Android → 9.2 gravações → 9.3 push e eventos → 9.4 publicação |
| Nome | TopCam, `br.com.suportinet.topcam`, já preparado para **white label** (pedido do Ewe) |
| Ao vivo | HLS primeiro (2 a 3 s de atraso). WebRTC numa etapa seguinte |

## O que o app faz

| Tela | Conteúdo |
|---|---|
| Entrar | E-mail e senha. A sessão fica guardada no cofre do celular e dura 30 dias desde o último uso |
| Primeiro acesso | Troca obrigatória da senha temporária, com as mesmas regras do painel |
| Câmeras | Só as liberadas para o usuário, por **local › grupo**, com o status (Online, Gravando, Sem sinal). Puxar para baixo atualiza; atualiza sozinha a cada 30 s |
| Ao vivo | HLS com endereço temporário (token de 2 h ligado ao usuário e à sessão). Som desligado por padrão, botão de som e tela cheia; deitar o celular amplia |
| Mosaico | Botão "Mosaico" no grupo com 2 ou mais câmeras no ar: até 4 por tela, em páginas. Tocar numa abre o ao vivo dela |
| Conta | Nome, e-mail, perfil e cliente; trocar senha (encerra as outras sessões); sair; versão e servidor |

Mensagens de erro em português: sem internet, servidor fora do ar, sessão expirada, câmera indisponível e falha ao tocar o vídeo, esta última com "Tentar de novo".

## Preparado para white label

**Cada provedor é uma pasta** em `apps/mobile/brands/<marca>/`:

```
brand.json   nome, identificador (Android/iPhone), servidor, cores, frase, e-mail de suporte
logo.png     opcional: logo quadrado, fundo transparente, 1024×1024
generated/   ícone, ícone adaptativo do Android, ícone temático, abertura e favicon
```

**Gerar o app de outro provedor:**

1. Criar a pasta com o `brand.json` e o `logo.png`.
2. Gerar as imagens: `python3 scripts/brand-assets.py <marca>`. Sem logo, desenha um provisório na cor da marca.
3. Gerar o APK: `scripts/mobile-build-apk.sh --brand <marca>`.

**Como funciona:**

- Todo o visual do app vem da marca: nome, ícone, cor das telas e servidor.
- O projeto nativo é gerado a cada build a partir da marca e não é versionado.

### Análise para o futuro

1. **Lojas.**
   - A Apple exige que um app de marca própria seja publicado **pela conta do próprio provedor** (diretriz 4.2.6). Na prática, cada provedor precisa da própria conta Apple Developer (US$ 99/ano) e, de preferência, da própria conta Google Play.
   - O build sai daqui; a publicação é na conta de cada um.
2. **Servidor.** Dois modelos possíveis:
   - **Cada provedor com o próprio TopCam:** já funciona hoje. Basta o `apiUrl` da marca apontar para o servidor dele, e é o mais simples e isolado.
   - **Vários provedores num servidor só:** exige um nível novo acima dos clientes (provedor › clientes), painel com a marca de cada um, domínio e e-mails por provedor. É uma mudança grande, para avaliar quando houver o primeiro provedor parceiro.
3. **Notificações (9.3).** Cada app de marca tem as próprias credenciais de push (Firebase/Apple). Vou desenhar o envio já com credenciais **por marca**, para não refazer depois.
4. **Automação.** Hoje um comando gera o APK de uma marca. Na 9.4 entram os perfis de build das lojas por marca.

## Testes

| Teste | Resultado |
|---|---|
| Unitários do app (cliente da API e regras das telas) | **8/8** |
| Suíte completa do projeto | **262/262** (eram 254) |
| Lint e tipagem do app (`expo lint`, `tsc`) e `expo-doctor` | Sem erros; doctor 21/21 |
| E2E do app (versão web do app, largura de celular, contra o laboratório) | **1/1**: primeiro acesso com senha fraca recusada e troca aceita; só as 2 câmeras liberadas (a CAM-003 não aparece), por local e grupo; ao vivo pediu o endereço e a lista HLS respondeu 200 com `#EXTM3U`; botão de som; mosaico pediu as 2 listas; reabrir mantém logado; Conta; sair; entrar de novo sem pedir troca |
| Formato do ao vivo para o player do celular | Com uma sessão "mobile", o endereço HLS do gateway foi lido pelo ffprobe (H.264 + AAC) e 4 s foram decodificados sem erro |
| APK | Compilado (16 min): `br.com.suportinet.topcam` 0.1.0 (versionCode 1), Android 7.0 (API 24) ou mais novo, arm64-v8a, 46 MB, servidor de produção embutido |

Capturas: `reports/screens/app-cameras.png`, `app-ao-vivo.png`, `app-mosaico.png`.

## O que NÃO foi testado (e como validar)

| Item | Por quê | Como validar |
|---|---|---|
| **Vídeo tocando no celular** | Não há emulador Android nesta máquina (sem aceleração), e o Chromium de teste não toca HLS. O formato foi conferido com ffprobe e ffmpeg | Roteiro abaixo |
| Celulares 32 bits (Android antigo e barato) | O APK de teste tem só arm64-v8a, para compilar mais rápido | Se o celular não instalar ("app não compatível"), gero com `--all-abis` |
| iPhone | Precisa da conta Apple Developer | Entra na 9.2 ou 9.4 |

## Roteiro do teste no celular

1. **Usuário de teste.** No painel de produção, crie um usuário em Clientes → Condomínio Sol → Usuários:
   - perfil **Visualizador**;
   - permissão "ao vivo" na **CAM-001 (TWG)** e em mais uma câmera do mesmo grupo, para testar o mosaico;
   - marque "trocar a senha no primeiro acesso".
2. **Instale o APK.** Copie `topcam-0.1.0.apk` para o celular Android e abra o arquivo. O Android pede para permitir a instalação "desta fonte"; permita.
3. **Confira, de preferência no 4G** (fora da rede da VM):
   - [ ] entrar e trocar a senha;
   - [ ] lista com as câmeras liberadas;
   - [ ] ao vivo da TWG tocando, com som ao tocar no botão;
   - [ ] tela cheia e celular deitado;
   - [ ] mosaico;
   - [ ] fechar o app pelo multitarefas e abrir de novo: continua logado;
   - [ ] sair.
4. Me diga o resultado e, se der algum erro, mande um print.

## Observações para a 9.4 (publicação)

- O APK de teste é assinado com a chave de depuração. Para a Play Store será criada a chave de envio (upload key).
- Algumas permissões padrão das bibliotecas (sobreposição de tela e armazenamento antigo) serão revisadas e removidas, se não forem usadas.

## Arquivos

**App: `apps/mobile/`**

- Projeto Expo SDK 57, fora do pnpm do monorepo, com o próprio npm.
- `app.config.ts`: configuração por marca.
- `brands/topcam/`: marca TopCam e as imagens geradas.
- `src/lib/`: `api.ts`, `auth.tsx`, `cameras.ts`, `brand.ts`, `store.ts`, `theme.ts`.
- `src/components/`: `ui.tsx`, `live-player.tsx`.
- `src/app/`: `_layout.tsx`, `index.tsx`, `login.tsx`, `trocar-senha.tsx`, `(tabs)/index.tsx`, `(tabs)/conta.tsx`, `camera/[id].tsx`, `mosaico.tsx`.
- `scripts/`: `brand-assets.py`, `web-preview.mjs`.
- `test/app.unit.test.ts`.

**Fora do app**

- `scripts/mobile-build-apk.sh`
- `e2e/app-mobile.spec.ts`
- `pnpm-workspace.yaml`, `.dockerignore`, `eslint.config.js`, `.prettierignore` e `.gitignore`: ajustes para manter o app separado do monorepo.

## Próxima etapa (9.2): gravações no app

- Teste da reprodução no iPhone; se o formato atual não servir, a API passa a montar uma lista HLS com os segmentos gravados.
- Calendário, linha do tempo com movimento em âmbar e player com avançar, voltar e velocidade.
- Respeito à permissão "pode reproduzir".
