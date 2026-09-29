# TopCam — Relatório da Fase 7 (monitoramento, alertas por e-mail e relatórios)

29/09/2026, no ambiente de desenvolvimento:

- **aceite: 9/9 critérios aprovados** (e-mails entregues a um servidor de e-mail de teste);
- **150 testes automatizados** aprovados (lint + unidade + integração com banco real e servidor SMTP real de teste);
- **E2E** das telas Dashboard, Eventos e Alertas, Relatórios e Integrações aprovado em 1440, 768 e 390 px, junto com o E2E das fases anteriores (32 aprovados, os demais dependem de vídeo real e ficam para a VM).

**VM: pendente.** Falta rodar o aceite lá e configurar o Gmail (passo a passo abaixo).

## Decisões nesta fase

- **E-mail pelo Gmail**, configurado pelo painel em **Configurações → Integrações** (pedido seu). Nada de senha no `.env`.
- Gravidade mínima padrão do e-mail: **erro** (câmera sem sinal, gravação parada, disco alto). "Atenção" fica só no painel, para não virar spam. Dá para mudar no cartão.
- Mais de 5 alertas novos no mesmo ciclo → **um e-mail de resumo**. Isso cobre, por exemplo, a queda de energia do local com várias câmeras.

## O que foi entregue

| Área | Entrega |
|---|---|
| Alertas de câmera | A cada 10 s: câmera ativa em **offline/erro** → alerta "sem sinal" (erro). Câmera que deveria gravar, está no ar e não confirma segmento há `RECORDING_STALL_S` → alerta "ao vivo, mas sem gravar". Ambos fecham sozinhos quando a situação volta ao normal |
| Alertas (todos) | Um alerta por problema enquanto estiver aberto (nunca duplica); **Reconhecer** e **Resolver** com autoria e auditoria (`alert.acknowledged`, `alert.resolved`). Resolver à mão um problema que continua: o sistema reabre no ciclo seguinte |
| Isolamento | Admin de cliente vê os alertas e eventos das câmeras dele. Operador e visualizador, só os das câmeras liberadas. Alertas sem câmera (disco, servidor) ficam para a plataforma. Outro cliente recebe 404 |
| E-mail (SMTP) | Configurações → Integrações → **E-mail (SMTP)**, só o Super Admin: servidor, porta, segurança (STARTTLS/SSL/nenhuma), usuário, senha, remetente, destinatários, gravidade mínima e "avisar quando resolver". Botão **Preencher para Gmail**, **Enviar e-mail de teste** e a lista dos últimos envios, com o erro quando falha |
| Senha do e-mail | Cifrada (AES-GCM, mesma chave das chaves RTMP) e **nunca devolvida** ao navegador. Em branco mantém a atual. Alterações ficam na auditoria (`integrations.smtp_updated`), sem a senha |
| Envio | A cada 15 s: alertas novos (ou que pioraram) a partir da gravidade mínima, e os resolvidos. Assunto do tipo `[TopCam] ERRO: CAM-001 · Entrada Principal (Empresa Alfa): câmera sem sinal`, com link para o painel. Falha de envio: registra o erro e tenta de novo em 5 min. Erro 535 do Gmail vira a mensagem "use uma senha de app" |
| Eventos e Alertas (tela) | Aba **Alertas** (ativos, abertos, reconhecidos, resolvidos, todos; filtro de gravidade e de cliente; detalhes com quem reconheceu/resolveu e quando o e-mail saiu) e aba **Eventos** (tipo, gravidade, período, pesquisa e cliente, com os dados técnicos de cada evento). Atualiza sozinha |
| Sino do cabeçalho | Número de alertas ativos visíveis ao usuário (vermelho com erro/crítico, amarelo só com atenção) |
| Dashboard | Mantém os cartões e acrescenta: gráficos de 24 h de **câmeras online** e **tráfego de entrada**, alertas ativos, últimos eventos, disco de vídeo (plataforma) e usuários conectados no painel e no app (quem gerencia usuários) |
| Relatórios | Disponibilidade por câmera no período (tempo no ar ÷ tempo observado, medido a cada 10 s), gravação (%), quedas, lacunas e volume gravado. Atalhos de hoje, 7 e 30 dias, filtro de cliente e **CSV** (separador `;` e vírgula decimal, abre direto no Excel em português). Período máximo: 93 dias |
| Prometheus | `prometheus` (7 dias ou 2 GB) + `node-exporter`, **só na rede interna**. Coleta a VM (CPU, memória, discos, rede, pressão) e o servidor de mídia. O worker lê a rede pelo Prometheus e mostra na tela **Servidores**, que agora também mostra o estado do Prometheus |
| Histórico | `camera_hourly` (disponibilidade por câmera e hora, 400 dias), `status_samples` (dashboard, 7 dias) e `notifications` (e-mails enviados, 90 dias) |
| Permissões | `alerts.write` (reconhecer/resolver) e `reports.read` (Relatórios): equipe da plataforma e admin de cliente. Integrações: só o Super Admin (`settings.write`) |
| Banco | Migration `0006` |

## Resultado do aceite (ambiente de desenvolvimento)

Evidência: `docs/evidencias/aceite-fase7-20260929.md`.

O aceite manda os e-mails para o **Mailpit** (servidor de e-mail de teste, perfil `test`), nunca para o Gmail. A configuração de e-mail salva no painel é guardada no início e **devolvida igual** no fim. Os alertas reais que "saíram" para o Mailpit durante o aceite voltam para "não avisado", para o Gmail avisar de verdade depois. Só a CAM-001 de teste sai do ar.

| # | Critério | Resultado |
|---|---|---|
| M1 | Prometheus coletando: node-exporter, servidor de mídia e ele mesmo | ✅ |
| M1b | Worker lê o Prometheus (serviço ok e rede na tela Servidores) | ✅ |
| M2 | Integrações: validação ("informe a senha de app"), senha nunca devolvida, e-mail de teste entregue e registrado | ✅ |
| M3 | Câmera cai → alerta em **9 s** e e-mail em **12 s** (critério: ≤ 60 s), com link para o painel | ✅ |
| M4 | Câmera volta → alerta fechado em 6 s e e-mail de "Resolvido" em 14 s | ✅ |
| M5 | Reconhecer/resolver com autoria e auditoria; o Condomínio Sol não vê nem reconhece alerta da Empresa Alfa (404) | ✅ |
| M6 | Dashboard, relatório (JSON e CSV), eventos com filtro; o cliente vê só as câmeras dele e não acessa Integrações (403) | ✅ |
| M7 | Histórico gravado (amostras do dashboard e horas por câmera) | ✅ |
| M8 | Lint e testes | ✅ |

## Problemas encontrados e corrigidos durante a fase

1. **Disponibilidade medida a cada minuto.** Quedas curtas sumiam do relatório. Agora mede a cada 10 s, no mesmo ciclo dos alertas.
2. **Aceite marcando alertas reais como "já avisados".** Ao ligar o e-mail de teste, os alertas abertos saíam para o Mailpit e o Gmail não avisaria depois. O aceite agora desfaz essas marcações no fim.
3. **Download do CSV.** O painel usa token em memória, e um link comum não levaria o login. Entrou uma função de download autenticada.

## Como configurar o Gmail na VM

1. Na conta Google que vai enviar: **Segurança → Verificação em duas etapas** (ligada) → **Senhas de app** → criar "TopCam". Copie a senha de 16 letras.
2. Painel → **Configurações → Integrações → E-mail (SMTP)**:
   - clique em **Preencher para Gmail**;
   - **Usuário** e **E-mail do remetente**: o Gmail completo; **Senha**: a senha de app;
   - **Destinatários**: um por linha;
   - marque **Enviar alertas por e-mail** e clique em **Salvar**.
3. Clique em **Enviar e-mail de teste**. Se falhar, a mensagem aparece no cartão e na lista de envios. A VM precisa de saída para `smtp.gmail.com:587`.

Ao ligar, os alertas que já estiverem abertos saem num único e-mail de resumo. As câmeras de teste que ficaram "offline" em aceites anteriores (Empresa Alfa, Condomínio Sol) também geram alerta "sem sinal". Para não receber esses avisos, desative as câmeras de teste que não estiverem em uso (Câmeras → desativar).

## Pendências

- Aceite na VM e configuração do Gmail (acima).
- `node-exporter` usa a montagem `/:/host:ro,rslave`, padrão do Debian com systemd. Se a atualização acusar erro de montagem, me avise.
- Fase 4: a conferência de 24 h reais da retenção (`recording:status` depois de 29/09 23:05) continua pendente.
