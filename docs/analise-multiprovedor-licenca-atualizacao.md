# Análise: instalação para outros provedores, app, licença e atualizações (21/11/2026)

Pedido do Ewe: analisar, sem implementar ainda, como seriam:

1. a instalação em um servidor de outro provedor;
2. o nome e o app (um app nosso neutro e o app com a marca do provedor);
3. uma licença que permita bloquear quem não pagar;
4. as atualizações nos clientes com pouco impacto.

---

## 1. Dois modelos de atendimento a provedores

| | **A. Hospedado por nós** (multiprovedor no nosso servidor) | **B. Servidor do provedor** (instalação dedicada) |
|---|---|---|
| Onde roda | No servidor da SuporTI. O provedor é um nível acima dos clientes dele (item 9 da lista: "marca do provedor") | Numa VM ou servidor do próprio provedor, com domínio dele (ex.: `cameras.provedorx.com.br`) |
| Quem opera | Nós (atualização, backup, monitoramento) | O provedor opera a máquina; nós atualizamos o sistema |
| Vídeo e internet | Passam pelo nosso link e disco | Ficam no link e no disco do provedor (bom para quem tem muitas câmeras ou exige os dados em casa) |
| Bloqueio por falta de pagamento | Simples: suspender o provedor (o cadastro já tem "suspenso") | Precisa de licença (seção 3) |
| Atualização | Uma só, no nosso servidor | Uma por instalação (seção 4) |
| Custo para nós | Disco, banda e servidor crescem com cada provedor | Baixo: o provedor paga a infraestrutura dele |

**Recomendação:** oferecer os dois. O modelo A atende provedores pequenos. O modelo B atende provedores grandes ou que exigem os dados no próprio servidor.

O mesmo código serve aos dois. O que muda é a configuração e os itens novos abaixo.

## 2. Nome e app

**Nome do produto:** o nome definitivo (que substitui "TopCam", por causa do app já existente na Play Store) vira o **nome do produto**. Para o provedor, aparece a marca dele. O nosso nome fica só em "Sobre" ("tecnologia ...").

**Painel web do provedor (modelo B):**

- domínio próprio;
- logo, cores e nome no painel, nos e-mails e na tela de login, configurados na instalação (hoje parte disso é fixa no código e precisa virar configuração);
- certificado HTTPS automático, como na VM 107.

### App neutro (nosso, um só na loja)

O app hoje aponta para um servidor fixo, definido na hora de gerar o APK. Para um único app atender vários servidores:

- **Primeira tela: "Código do provedor"** (ex.: `provedorx`), ou e-mail que o sistema reconhece. Um **diretório central nosso** responde com o endereço do servidor daquele provedor, o nome e o logo.
- O app guarda isso. Depois do login, aparecem o logo e a cor do provedor (mesmo mecanismo do item 9 da lista).
- Funciona para os dois modelos (A e B), e é o modelo aceito pela Apple: um app único com os clientes por dentro (regra 4.2.6).

**Push no app neutro:** os endereços de push pertencem ao projeto Expo do nosso app. Com a "segurança de push" ligada (recomendado), só quem tem o nosso token consegue enviar. O servidor do provedor **não deve receber esse token**. Solução: o servidor do provedor manda o alarme para um **relé de push central nosso**, autenticado pela licença dele, e o relé envia pela Expo. Isso também permite medir e cobrar por uso, se fizer sentido.

### App com a marca do provedor (white label)

- Já previsto no código: uma pasta por marca (nome, logo, cores, servidor, Firebase, projeto Expo e chave de assinatura próprios).
- Publicado na conta de desenvolvedor do provedor (Google e Apple), como analisado antes. Na conta da SuporTI, só Android e com autorização escrita.
- Aponta direto para o servidor do provedor, sem precisar do código do provedor.
- O push sai pelas credenciais do próprio provedor, sem passar pelo relé.
- Enquanto o app dele não sai na loja, os clientes usam o **app neutro** com o código do provedor. Depois podem migrar, sem mudar nada no servidor.

## 3. Licença e bloqueio por falta de pagamento

**Peças:**

1. **Servidor de licenças central (nosso).** Cadastro dos provedores e das instalações: plano, limite de câmeras, vencimento, situação (ativo, em atraso, bloqueado).
2. **Licença assinada digitalmente** (Ed25519), instalada no servidor do provedor: quem é, limite de câmeras, validade. O sistema só confia em licença assinada pela nossa chave privada, que nunca sai do nosso servidor.
3. **Renovação automática:** a instalação consulta o servidor de licenças uma vez por dia e recebe uma licença nova, válida por alguns dias. Sem internet, ela continua funcionando até o fim da validade, com uma **carência** (ex.: 15 dias) para não bloquear por queda de link.

**Bloqueio em etapas (sugestão, a decidir):**

| Etapa | Quando | Efeito |
|---|---|---|
| 1. Aviso | Vencimento próximo ou atraso | Faixa no painel do provedor: "licença vence em X dias" |
| 2. Restrição | Atraso além do combinado | Não cadastra câmeras nem usuários novos; painel administrativo em modo leitura |
| 3. Bloqueio | Após o prazo final | Painel e app mostram "serviço suspenso — contate o fornecedor". Ao vivo e reprodução param |

**Cuidados:**

- **Câmera de segurança é sensível.** Desligar de repente pode deixar um condomínio sem vigilância. Sugiro que, no bloqueio, a **gravação continue por um tempo** (sem acesso para assistir) e que os dados **nunca sejam apagados** pelo bloqueio. As etapas e os prazos devem estar no **contrato**.
- **Limite técnico:** num servidor que é do provedor, quem tem acesso total à máquina pode tentar burlar a licença. Para dificultar:
  - entregar só **imagens prontas** (sem o código-fonte);
  - atualizações liberadas só para licenças válidas (registro privado de imagens com credencial por licença);
  - **o contrato é a proteção principal**.
- **Modelo A (hospedado):** o bloqueio é direto. Suspender o provedor no nosso servidor bloqueia todos os clientes dele, com as mesmas etapas.

## 4. Atualizações com pouco impacto

**Como é hoje (VM 107):**

- o pacote de código é copiado para a VM;
- `update.sh` monta as imagens na própria VM, aplica as migrations e reinicia só os serviços que mudaram;
- o servidor de mídia não reinicia se não mudou, então as câmeras continuam transmitindo e gravando;
- painel e app ficam alguns segundos indisponíveis.

**Para muitas instalações:**

1. **Imagens prontas e versionadas.** Construídas e testadas uma vez por nós, guardadas num registro privado (ex.: `topcam/app:1.4.2`). A atualização baixa a imagem, sem compilar no servidor do cliente: é mais rápida, igual em todos e não precisa do código-fonte.
2. **Backup automático antes de atualizar**, e **volta automática** para a versão anterior se os serviços não ficarem saudáveis em X minutos.
3. **Migrations só aditivas**, o padrão que já seguimos: a versão nova e a anterior funcionam com o mesmo banco, o que permite voltar sem restaurar backup.
4. **Servidor de mídia separado:** é o único cuja reinicialização derruba as câmeras por ~15 s. Ele só é atualizado quando necessário, em janela avisada, e a gravação retoma sozinha.
5. **Implantação em ondas:** primeiro o nosso servidor; depois alguns provedores voluntários; depois todos. O servidor de licenças diz qual versão cada instalação deve receber, o que também serve para segurar uma versão com problema.
6. **Janela de manutenção:** cada provedor escolhe o horário (ex.: madrugada) ou aplica pelo botão "Atualizar" no painel.
7. **Compatibilidade com o app:** o servidor continua aceitando as versões antigas do app por um período, e o app avisa quando houver versão nova obrigatória. Nenhuma atualização de servidor quebra um app que ainda não foi atualizado na loja.

## 5. Proposta de etapas (para decidir depois)

1. **Configuração de marca no painel e nos e-mails** (sai do código fixo). Necessária para qualquer instalação de outro provedor.
2. **Imagens prontas + atualização por versão + volta automática.** Reduz o risco já na VM 107.
3. **Servidor central** (licenças, diretório de provedores, relé de push) + **licença na instalação**.
4. **App neutro com código do provedor.**
5. **Marca do provedor no app** (item 9 da lista), que se apoia nas etapas 1 e 4.

## Decisões em aberto

- **Nome definitivo do produto**, que vale para o app neutro e para "tecnologia ..." nos provedores.
- **Bloqueio:**
  - prazos de cada etapa;
  - se a gravação continua durante o bloqueio.
- **Quais modelos oferecer:** só hospedado, só no servidor do provedor, ou os dois.
- **Onde fica o servidor central:** é pequeno e pode ficar na própria VM da SuporTI ou separado. Ele precisa ficar sempre no ar, porque os apps neutros dependem dele no primeiro acesso.
