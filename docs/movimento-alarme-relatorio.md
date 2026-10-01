# Movimento, gravação por movimento e alarme

Pedido em 01/10/2026 e aprovado como escopo novo. Isso muda a decisão D8 do plano.

| Item | Situação |
|---|---|
| Laboratório | Pronto e testado |
| Produção (VM 107) | Ainda não aplicado. Aplicar **depois** do teste de 7 dias, que começou em 01/10/2026 às 13:22 |

## O que foi feito

### Cadastro da câmera (Câmeras → Nova/Editar)

**Gravação**

- Opções: somente ao vivo, **contínua** ou **só com movimento**, mais a retenção (24 h, 3 dias ou 7 dias).
- Na gravação só com movimento, cada movimento é guardado com **10 s antes e 30 s depois**.
- O que não teve movimento é apagado depois de **1 hora**.

**Detecção de movimento**

- **Desligada.**
- **Pela câmera (aviso por e-mail):**
  - para câmeras com detecção própria, como a Intelbras VIP 1230 FC+, que detecta pessoa;
  - a câmera manda um e-mail a cada detecção;
  - funciona atrás de NAT/CGNAT, porque quem abre a conexão é a câmera.
- **Pelo servidor:**
  - para câmeras sem aviso utilizável, como a Mibo e a TWG;
  - o servidor compara as imagens a cada quadro-chave (1 a 2 s), em 160×90 e em tons de cinza;
  - não transcodifica o vídeo gravado nem o ao vivo;
  - a sensibilidade vai de 1 a 10;
  - uma mudança geral de brilho (dia/noite, infravermelho) não conta como movimento.

**Alarme: notificar quando houver movimento**

- **Horários:**
  - faixas por dia da semana ("das 22:00 às 06:00", que atravessa a meia-noite);
  - sem faixa cadastrada, o alarme vale sempre;
  - horário de Brasília.
- **Fora do horário** a câmera continua detectando e gravando; só não notifica.
- **Intervalo mínimo entre avisos:** 1, 5, 15, 30 ou 60 min.
- **Quem recebe:** os usuários do cliente com acesso à câmera, mais o administrador do cliente.
- **Canal hoje:** e-mail, usando o mesmo SMTP de Integrações.
- **Notificação no app:** entra com o app (Fase 9), usando a mesma decisão de cada movimento.
- **Link no e-mail:** abre a gravação no horário do movimento.

**Credencial de eventos** (detalhes da câmera; só a equipe da plataforma)

- Gera o usuário e a senha que a câmera usa para mandar o e-mail.
- A senha só aparece na hora; o banco guarda o hash.
- Gerar de novo invalida a anterior.

### Linha do tempo (Gravações)

- Movimento marcado em **âmbar** por cima da gravação, com a legenda "Movimento (n)" e o tipo ao passar o mouse (pessoa ou movimento).
- O trecho apagado por não ter movimento aparece como "sem gravação / sem movimento", **não** como lacuna de sinal.
- As lacunas de verdade (queda de sinal) continuam em vermelho.

### Serviços e banco

**Serviço novo `motion`** (mesma imagem da aplicação, separado do worker para não disputar CPU)

- Receptor de e-mail na porta **2525**:
  - STARTTLS com o certificado do painel, mas aceita câmera sem criptografia;
  - 10 senhas erradas → IP bloqueado por 30 min, com evento;
  - até 720 avisos por câmera por hora;
  - o conteúdo do e-mail (inclusive a foto) não é guardado.
- Detector do servidor:
  - um ffmpeg por câmera no ar;
  - volta sozinho se cair;
  - 5 falhas seguidas viram evento da câmera.

**Worker**

- Mantém os segmentos que encostam num movimento.
- Decide o alarme de cada movimento: horário, intervalo mínimo, destinatários.
- Envia o e-mail.

**Migration `0011_movimento_alarme.sql`** (só adiciona)

- Campos novos na câmera.
- Tabelas `motion_events` e `alarm_notifications`, com isolamento por cliente (RLS).
- Nos segmentos: `motion_hold` e `deleted_reason`.

**Como a gravação só com movimento funciona**

- O servidor de mídia continua gravando segmentos de 60 s normalmente.
- Cada segmento nasce "em espera", valendo 1 h.
- Os que encostam num movimento passam a valer a retenção normal.
- Os outros saem pela retenção, com o motivo `no_motion`.
- **Vantagens:**
  - os segundos antes do movimento ficam guardados;
  - nada no servidor de mídia é reconfigurado;
  - "gravando", alertas de falha, backup e relatórios continuam iguais.

**Outros ajustes**

- **Trocar para gravação contínua** (ou desligar a gravação): o que estava em espera passa a valer a retenção normal. Nada é apagado de surpresa.
- **Transferência de câmera:**
  - movimento e alarme vão junto;
  - mantendo a chave, a credencial de eventos também vai.
- **Firewall do host:**
  - porta 2525 liberada;
  - o serviço do host reaplica as regras sozinho no minuto seguinte à atualização (as portas entram no hash);
  - a porta aparece na tela do firewall.
- **Relatório de 7 dias:** seção nova "Movimento e alarme" e avisos de falha no envio e no detector.
- **Transmissor de teste:** `TX_STILL=1` transmite imagem parada (teste da detecção).

## Testes

| Tipo | Resultado |
|---|---|
| Unitários e integração | **254/254** (eram 214). Novos: agenda do alarme (inclusive a meia-noite), credencial, comparação de quadros, receptor SMTP real, retenção por movimento sem lacuna falsa, alarme e detector com ffmpeg real |
| Mesmos testes na imagem de testes do Compose | 254/254 |
| E2E (Playwright) | **46 aprovados**, sem falhas: cadastro nas 3 larguras, credencial, linha do tempo com movimento |
| Aceite `scripts/accept-motion.sh` no laboratório | **7/7, 1 pulado** (firewall: serviço do host não instalado no laboratório) |

### Aceite no laboratório (01/10/2026)

| # | Critério | Resultado |
|---|---|---|
| V1 | Serviço no ar e porta 2525 respondendo | ✅ |
| V2 | E-mail com STARTTLS e sem criptografia vira movimento; avisos seguidos viram um só | ✅ |
| V3 | Senha errada recusada | ✅ |
| V4 | Detector do servidor: movimento gera aviso; imagem parada, nenhum | ✅ |
| V5 | Segmentos em espera de 60 min; os com movimento passam para a retenção normal | ✅ 3 mantidos, 2 em espera |
| V6 | Alarme decide cada movimento | ✅ |
| V7 | Firewall libera 2525 | pulado (laboratório) |
| M1 | Lint e testes | ✅ |

### Outros testes no laboratório

| Teste | Resultado |
|---|---|
| Ponta a ponta do alarme | Um e-mail enviado do host pela porta publicada (como a câmera faria) virou "pessoa", e o alarme mandou o e-mail ao administrador do cliente: "[TopCam] Pessoa detectada: Recepção (Matriz)" |
| Custo do detector numa câmera 1080p (1,8 Mbps, quadro-chave a cada 2 s) | Cerca de 2 a 3% de um vCPU em média (picos de 7%) e 64 MB para o serviço inteiro. Detectou 24 avisos em ~95 s de vídeo com movimento |

## O que NÃO foi testado (e como validar)

| Item | Por quê | Como validar |
|---|---|---|
| Intelbras VIP 1230 FC+ real | Não tenho acesso à câmera | Roteiro abaixo; o TopCam registra "E-mail de teste da câmera recebido" nos eventos da câmera |
| Mibo iM5 | Só a iM5 S/SC tem RTMP. A iM5 original (só RTSP/ONVIF) não entra no TopCam hoje | Confirmar o modelo na etiqueta. Se for S/SC: cadastrar em RTMP e usar "pelo servidor" |
| Firewall do host com a porta 2525 | O laboratório não tem o serviço do host | O V7 do aceite na produção confere |
| E-mail do alarme pelo Gmail de produção | No laboratório usei um SMTP local | Depois de aplicar: alarme ligado numa câmera de teste e ver o e-mail chegar |

## Configurar a Intelbras VIP (roteiro)

Os nomes dos menus variam com o firmware.

1. **No TopCam:**
   - Câmeras → editar → Detecção de movimento: **Pela câmera (aviso por e-mail)** → Salvar;
   - detalhes da câmera → **Gerar usuário e senha**.
2. **Na câmera, Rede → SMTP (E-mail):**

   | Campo | Valor |
   |---|---|
   | Servidor | `topcam.suportinet.com.br` |
   | Porta | `2525` |
   | Usuário e senha | os gerados no TopCam |
   | Criptografia | TLS/STARTTLS se houver, senão nenhuma |
   | Remetente e destinatário | qualquer endereço (ex.: `eventos@topcam.suportinet.com.br`) |

   Use o botão **Teste**: deve aparecer "E-mail de teste da câmera recebido" nos eventos da câmera.
3. **Na câmera, Eventos:**
   - em **Detecção inteligente de movimento** (pessoa) ou **Detecção de vídeo → Movimento**, marque a ação **Enviar e-mail**;
   - recomendado: a detecção de pessoa, que corta os falsos alarmes;
   - o intervalo entre e-mails da câmera pode ficar curto: o TopCam junta os avisos seguidos num só movimento.

## Pendências e observações

1. **Quem altera.** Movimento e alarme ficam no cadastro da câmera, que hoje só a equipe da plataforma edita. O administrador do cliente não muda os horários do alarme. Se quiser que o cliente ajuste, isso entra no app ou num ajuste de permissão, com sua decisão.
2. **Precisão.** Os segmentos têm 60 s, então o menor trecho guardado tem por volta de 1 min (10 s antes e 30 s depois do movimento, arredondados para os segmentos inteiros).
3. **Detector do servidor.**
   - Não distingue pessoa de sombra, chuva ou galhos.
   - Um movimento mais curto que o intervalo entre quadros-chave pode passar despercebido.
   - Para pessoa, use a detecção da câmera.
4. **Disco.** O "uso estimado em regime" (Armazenamento) continua calculado como gravação contínua. Para câmeras por movimento, a conta fica para cima (conservadora).
5. **Reconhecimento facial.** Fica para o fim: hardware dedicado e a parte da LGPD.

## Aplicar na produção (depois do teste de 7 dias)

1. **Relatório de 7 dias**, a partir de 08/10, depois das 13:22:

   ```
   cd /opt/topcam && scripts/report-7days.sh --since "2026-10-01 13:22"
   ```

2. **Atualização**, com o pacote `topcam-movimento.bundle`:

   ```
   cd /opt/topcam && nohup scripts/update.sh --bundle /root/topcam-movimento.bundle > /root/update10.log 2>&1 &
   ```

   Quando `tail -3 /root/update10.log` mostrar `atualização concluída`, rode `git push`.
3. **Aceite:**

   ```
   cd /opt/topcam && nohup scripts/accept-motion.sh > /root/aceite-movimento.log 2>&1 &
   ```

   - leva ~8 minutos;
   - só usa câmeras do cliente de teste Empresa Alfa;
   - a TWG não é tocada.
4. **Depois:** troca dos segredos (`scripts/rotate-secrets.sh --all`) e fechamento da Fase 8.

## Arquivos

**Banco**

- `packages/db/migrations/0011_movimento_alarme.sql`
- `packages/db/src/motion.ts`
- `packages/db/src/recordings.ts`

**Regras comuns**

- `packages/shared/src/motion.ts` (agenda do alarme, credencial, tipo do aviso)

**Worker e serviço `motion`**

- `apps/worker/src/events/smtp.ts` (receptor)
- `apps/worker/src/motion/detector.ts`
- `apps/worker/src/motion/manager.ts`
- `apps/worker/src/motion-main.ts`
- `apps/worker/src/jobs/motion.ts` (alarme e retenção)
- `apps/worker/src/main.ts`

**API**

- `apps/api/src/routes/cameras.ts` (campos, credencial, transferência)
- `apps/api/src/routes/recordings.ts` (linha do tempo)
- `apps/api/src/routes/firewall.ts`

**Painel**

- `apps/web/components/motion-settings.tsx`
- `apps/web/components/recording-timeline.tsx`
- `apps/web/app/(painel)/cameras/page.tsx`
- `apps/web/app/(painel)/gravacoes/page.tsx`

**Infraestrutura e scripts**

- `compose.yaml` (serviço `motion`, porta 2525)
- `scripts/host/topcam-host` (porta 2525)
- `scripts/accept-motion.sh` (novo)
- `scripts/report-7days.sh`
- `tools/test-transmitter/transmit.sh`

**Testes**

- `packages/shared/test/motion.unit.test.ts`
- `apps/worker/test/motion.unit.test.ts`
- `apps/worker/test/motion.int.test.ts`
- `apps/api/test/motion.int.test.ts`
- `e2e/movimento.spec.ts`
