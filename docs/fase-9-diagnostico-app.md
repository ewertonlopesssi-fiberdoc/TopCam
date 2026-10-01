# Fase 9: app mobile — diagnóstico (01/10/2026)

Antes de programar: o que o app terá, o que a API já oferece, o que falta, como gerar o app e o que preciso do Ewe.

## O que a especificação pede

"Aplicativo mobile: login e senha, grupos, ao vivo, reprodução da câmera gravada, eventos e conta; acesso sempre mediado pela API."

Desde 01/10 também entra a **notificação de alarme** (movimento), prevista no desenho de movimento e alarme.

## Telas propostas

| Tela | Conteúdo |
|---|---|
| Entrar | E-mail e senha. Troca obrigatória da senha no primeiro acesso. Sessão mantida (30 dias), guardada no cofre do celular |
| Câmeras | Locais › grupos › câmeras do usuário (só as liberadas para ele), com o status (no ar, gravando, sem sinal) |
| Ao vivo | Uma câmera em tela cheia (deitar o celular) ou mosaico de 4. Som liga/desliga |
| Gravações | Dia no calendário, linha do tempo com lacunas e **movimento em âmbar** (igual ao painel), player com avançar/voltar e velocidade |
| Eventos | Movimentos e quedas de sinal das câmeras do usuário. Tocar abre a gravação naquele horário |
| Notificações | Push de alarme ("Pessoa detectada: Portão — Condomínio Sol"). Tocar abre a gravação no horário |
| Conta | Nome, e-mail, trocar senha, ativar/desativar notificações neste celular, sair |

Só **usuários de cliente** (administrador do cliente, operador e visualizador) usam o app. A equipe da plataforma continua no painel web.

## O que a API já tem

| Necessidade | Situação |
|---|---|
| Login do app | ✅ A sessão do tipo `mobile` já existe desde a Fase 2: o refresh token vai no corpo (não em cookie) e é rotacionado |
| Câmeras, locais e grupos com permissão por usuário | ✅ |
| Ao vivo | ✅ Endereço temporário com token (HLS e WebRTC) |
| Gravações | ✅ Dias, segmentos, lacunas, movimento e endereço de reprodução com token |
| Eventos e alertas | ✅ Já filtrados pelo cliente |
| Trocar senha | ✅ |
| HTTPS com domínio | ✅ Fase 8 |

## O que falta construir

1. **Notificação push**
   - Cadastro do celular: tabela de dispositivos por usuário, com entrada e saída automáticas no login e no logout.
   - Envio pelo worker no alarme, pelo serviço de push do Expo (que entrega pelo Firebase no Android e pela Apple no iPhone). O canal `push` já existe na tabela de notificações do alarme; hoje só o e-mail é usado.
   - Tocar na notificação abre a gravação no horário.
2. **Reprodução no iPhone (risco a testar primeiro)**
   - Hoje a reprodução é um MP4 contínuo (fMP4) gerado na hora pelo servidor de mídia. O Android toca isso bem.
   - O player do iPhone costuma exigir arquivo com tamanho conhecido ou HLS.
   - Se falhar, a solução é a API montar uma lista HLS (VOD) com os próprios segmentos gravados, sem reprocessar vídeo.
   - Faço esse teste antes de qualquer tela de gravação.
3. **Ao vivo no celular**
   - **HLS** funciona nos dois sistemas, com 2 a 3 s de atraso.
   - **WebRTC** (< 1 s, como no painel) exige um componente nativo extra.
   - Proposta: começar com HLS e deixar o WebRTC para uma etapa seguinte.
4. **Página de política de privacidade** (exigida pelas lojas, e pela LGPD), publicada no próprio domínio.
5. **Exclusão de conta:** a Apple exige um caminho para pedir a exclusão. Como as contas são criadas pelo provedor, basta um "solicitar exclusão" que avisa a equipe.

## Tecnologia

- **Expo (React Native) + TypeScript**, em `apps/mobile` no mesmo repositório. Reaproveita os tipos e as regras de `packages/shared`.
- **Android:** consigo gerar o APK de teste aqui (o SDK do Android baixa nesta máquina). O Ewe instala direto no celular, sem loja.
- **iPhone:** só sai por compilação na nuvem do Expo (EAS), com conta Apple de desenvolvedor, e teste pelo TestFlight. Não há como gerar o app do iPhone sem essa conta.

## Etapas propostas

| Etapa | Entrega | Critério de aprovação |
|---|---|---|
| **9.1** Base Android | Projeto, login, troca de senha, câmeras por local/grupo, ao vivo (HLS, 1 e 4), conta. APK de teste | O Ewe instala o APK, entra com um usuário de cliente, vê só as câmeras liberadas e assiste a TWG ao vivo |
| **9.2** Gravações | Teste de reprodução no iPhone (HLS VOD se precisar), calendário, linha do tempo com movimento, player | Reproduz um horário escolhido; movimento marcado; visualizador sem "pode reproduzir" vê o aviso |
| **9.3** Push e eventos | Cadastro do celular, push do alarme pelo worker, tela de eventos | Movimento na câmera → notificação em segundos (respeitando horário e intervalo mínimo) → abre a gravação |
| **9.4** Publicação | Nome, ícone, splash, política de privacidade, Android na Play Store (teste interno) e iPhone no TestFlight | Instalado pelas lojas em teste fechado |

Cada etapa termina como as fases anteriores: código, testes, relatório e aprovação. Nada vai para a produção durante o teste de 7 dias.

## O que preciso do Ewe

| Item | Quando | Observação |
|---|---|---|
| Nome do app e identificador | 9.1 | Ex.: "TopCam" e `br.com.suportinet.topcam` (o identificador não muda depois de publicado) |
| Logo/ícone (PNG 1024×1024) e cor principal | 9.1 (pode ser provisório) | Sem logo, uso um ícone provisório com o nome |
| Um usuário de cliente de teste na produção | 9.1 | Ex.: um visualizador do Condomínio Sol com acesso à TWG |
| Celular Android para testar o APK | 9.1 | Permitir "instalar de fontes desconhecidas" |
| Conta Expo (gratuita) | 9.3 | Push e compilação do iPhone |
| Projeto Firebase (gratuito) | 9.3 | Push no Android |
| Conta Google Play Console (US$ 25, uma vez) | 9.4 | Em nome da empresa |
| Conta Apple Developer (US$ 99/ano) | 9.2 ou 9.4 | Pessoa jurídica exige número D-U-N-S (gratuito, leva alguns dias): vale pedir já |
| E-mail de suporte e responsável pelos dados (LGPD) | 9.4 | Para a política de privacidade e as lojas |

## Riscos

- **Reprodução no iPhone:** tratado no início da 9.2.
- **Revisão da Apple:** pede uma conta de demonstração e a política de privacidade. Pode levar alguns dias e voltar com pedidos de ajuste.
- **Notificação no iPhone:** só funciona com o app instalado pelo TestFlight ou pela loja, e com a permissão aceita pelo usuário.
- **Atraso do ao vivo:** com HLS fica em 2 a 3 s; o WebRTC (< 1 s) fica para depois.
