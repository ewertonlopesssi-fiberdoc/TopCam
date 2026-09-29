# TopCam — Relatório da Fase 6 (armazenamento e proteção de disco)

29/09/2026, no ambiente de desenvolvimento, com gravação real do transmissor de teste:

- **aceite: 11/11 critérios aprovados**;
- **131 testes automatizados** aprovados;
- **E2E das telas Armazenamento e Servidores** aprovado em 1440, 768 e 390 px.

Ainda falta rodar na VM (procedimento no fim).

## Decisões suas nesta fase

- **Cota do cliente:** só alerta, sem parar a gravação.
- **Disco de vídeo a 95%:** apagar primeiro as gravações mais antigas, mesmo dentro da retenção.
  - Proteção adicional: nunca apaga as gravações da última hora (ajustável).
  - Se não houver o que apagar, a gravação para e volta sozinha.

## O que foi entregue

| Área | Entrega |
|---|---|
| Vigia de disco | A cada 30 s o worker mede o disco de vídeo (espaço e volume gravado) e grava estado, percentual e latência. Uma amostra a cada 5 min fica 7 dias, para os gráficos |
| Níveis | **70% atenção, 85% alto, 95% crítico**, ajustáveis por disco. Cada mudança gera evento, e há um alerta por disco (atualizado, nunca duplicado) que se fecha ao voltar ao normal |
| Cota do disco | Opcional: com cota, vale o gravado ÷ cota, que funciona como o orçamento de vídeo daquele disco. O disco físico volta a valer quando ele mesmo chega ao crítico |
| Limpeza de emergência | No crítico, apaga os segmentos mais antigos **daquele disco** até voltar a crítico − 5 (90%). Nunca apaga os mais novos que a idade mínima (60 min). Gera evento com quantidade, MB, período e câmeras, um alerta que fica aberto até o disco voltar ao normal, e registro na **auditoria** (`storage.emergency_purge`). Usa o mesmo caminho da retenção, que nunca apaga fora da pasta de gravações |
| Proteção final | Sem nada apagável e ainda crítico: **a gravação do disco para** (o servidor de mídia deixa de gravar), com alerta crítico. O ao vivo, o painel e o banco continuam. A gravação volta sozinha abaixo de 90% |
| Disco lento | A cada 30 s, grava 64 KiB com sincronização no disco de vídeo. Acima de **1 s**, abre o alerta "disco lento", que se fecha após ~5 min estável. É o problema das travadas no armazenamento do Proxmox |
| Buracos na gravação | A conferência de cada segmento procura saltos de mais de 3 s entre quadros. Os trechos sem vídeo dentro do arquivo viram lacuna na linha do tempo (como "quadros perdidos"), dividem a exportação e geram evento |
| Cota do cliente | Uso de vídeo de cada cliente comparado à cota do cadastro: alerta de atenção em 90% e de erro em 100%. Nada é apagado nem parado |
| Disco do sistema | Banco, Docker e logs: alerta em 85% (erro) e 95% (crítico), sem ação automática |
| Tela Armazenamento | Uso com as marcas 70/85/95, gravações no disco, uso estimado em regime (gravado na última hora × retenção), últimas 24 h, latência (agora e máxima), gráficos de 24 h de uso e latência, limites e cota (Super Admin), limpeza de emergência (liga/desliga e idade mínima), uso por cliente e por câmera, alertas e eventos |
| Tela Servidores | Estado do servidor de mídia, câmeras no ar e gravando, CPU, carga, memória, disco do sistema, **espera por disco** (pressão de IO do kernel), tempo ligado e serviços (API, worker, banco, Redis, servidor de mídia) |
| Acesso | Leitura para a equipe da plataforma (`storage.read`); alteração só para o Super Admin (`storage.write`). Usuários de cliente não veem as telas nem a API |
| Banco | Migration `0005`: toda câmera passa a ter disco definido. Antes o bloqueio por disco não teria efeito, porque a câmera não apontava para disco nenhum. Entram também o histórico de amostras, os buracos por segmento e as configurações da limpeza |

## Resultado do aceite

Evidência: `docs/evidencias/aceite-fase6-20260929.md`. O aceite **não enche o disco de verdade**. Ele cria um disco de teste (`aceite6`), coloca nele só a CAM-001 de teste e reduz a cota. A TWG e as outras câmeras não são tocadas.

| # | Critério | Resultado |
|---|---|---|
| S1 | Disco medido (confere com o `df`) e latência | ✅ |
| S2 | 76% → atenção; 88% → alto; eventos e alerta | ✅ |
| S3 | 97% → apagou o segmento mais antigo (só CAM-001 de teste), voltou a 73%; evento, alerta e auditoria; nenhum outro disco tocado | ✅ |
| S4 | Nada apagável (idade mínima 24 h) → gravação parada no servidor de mídia, câmera "ao vivo", alerta crítico | ✅ |
| S4b | Com a gravação parada, o ao vivo (HLS) e a API funcionam | ✅ |
| S5 | Espaço liberado → gravação voltou sozinha, com segmento novo conferido e alerta fechado | ✅ |
| S6 | Cota do cliente → só alerta; nenhum segmento apagado | ✅ |
| S7 | APIs de Armazenamento e Servidores; usuário de cliente → 403 | ✅ |
| S8 | Latência real (informativo): aqui houve **uma travada de 1,7 s**, detectada com alerta | ✅ |
| S9 | Buracos nas câmeras reais em 24 h (informativo) | ✅ nenhum |
| S10 | Lint e testes | ✅ 131/131 |

## Problemas encontrados e corrigidos durante a fase

1. **Bloqueio por disco sem efeito.** As câmeras não apontavam para nenhum disco, e o bloqueio procurava o disco da câmera.
   - **Solução:** a migration preenche o disco de todas as câmeras, e um gatilho preenche o das novas.
2. **Cota e disco físico.** Com cota, "o maior dos dois" deixava o disco físico cheio (aqui, 90% por outros motivos) mandando no nível. Assim a cota não servia para nada.
   - **Solução:** com cota vale a cota, e o disco físico só volta a valer no crítico, como proteção.
3. **Aviso de limpeza sumindo.** O alerta de gravação apagada antes do prazo se fechava no mesmo ciclo em que abria.
   - **Solução:** agora fica aberto até o disco voltar ao normal.
4. **No roteiro de aceite:**
   - estouro de inteiro ao calcular a cota;
   - comparação de `true` com `t`;
   - retomada do teste dependia do disco físico.
   - **Solução:** os três corrigidos.

## Mudanças em relação ao plano

| Plano | Implementado | Motivo |
|---|---|---|
| 95%: parar a gravação | Primeiro apaga o mais antigo (mesmo dentro da retenção); parar vira a proteção final | Sua decisão |
| — | Alerta de disco lento e detecção de buracos na gravação | Achado da Fase 5: travadas do armazenamento do Proxmox |
| — | Espera por disco (pressão de IO) na tela Servidores | Mesmo motivo |
| "Previsão de esgotamento" | "Uso estimado em regime" (gravado na última hora × retenção) | Com retenção fixa o disco não cresce sem parar. O que importa é se o volume em regime cabe |

## O que NÃO foi testado aqui (e como validar)

| Item | Como validar |
|---|---|
| VM | `scripts/accept-phase6.sh` (abaixo), ~15 min, deve dar 11/11 |
| Disco de vídeo real a 95% | Não enchemos o disco de 35 GB de propósito. O aceite prova a mesma lógica com a cota do disco de teste |
| Travadas do Proxmox | Depois de atualizar, veja na tela Armazenamento a latência máxima em 24 h e os alertas de disco lento; na tela Servidores, a espera por disco |

## Atualizar a VM e validar

```bash
cd /opt/topcam
nohup scripts/update.sh --bundle /root/topcam-fase6.bundle > /root/update6.log 2>&1 &
tail -f /root/update6.log                               # até "atualização concluída"; Ctrl+C
nohup scripts/accept-phase6.sh --no-build > /root/aceite6.log 2>&1 &   # uma vez só
tail -f /root/aceite6.log                               # ~15 min; 11/11
git push
```

A atualização aplica a migration `0005` e recria a API, o worker e o painel. O servidor de mídia não reinicia, então a TWG continua gravando sem lacuna.

## Próxima fase (7): monitoramento, dashboard, eventos e relatórios

- Prometheus.
- Dashboard (tela 1).
- Tela Eventos e Alertas: reconhecer e resolver.
- Relatórios.
- Alertas por e-mail.
