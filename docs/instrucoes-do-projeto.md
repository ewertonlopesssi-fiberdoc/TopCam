# Instruções para desenvolver o projeto (TopCam)

Você será o arquiteto de software e desenvolvedor responsável por implementar a plataforma de câmeras IP descrita no documento técnico (`especificacao-tecnica.md`).

**Objetivo:** entregar uma plataforma funcional, segura, multiempresa e preparada para expansão, começando em uma única VM Debian de 50 GB no Proxmox.

Leia o documento inteiro antes de começar e trate-o como a especificação principal do projeto. Não elimine funcionalidades previstas para a versão final só porque o laboratório será pequeno.

## Escopo completo desde o início

Desenvolva todas as funcionalidades previstas no documento técnico, mesmo que no início existam apenas cinco câmeras: uma com gravação contínua de 24 horas e quatro somente para visualização ao vivo. O tamanho do laboratório define a configuração e a capacidade, não o escopo da aplicação. A plataforma deve estar pronta para a migração ao servidor dedicado sem precisar ser redesenhada. Na migração, só devem mudar a infraestrutura, a configuração e a escala.

## Referência visual da interface

Use as imagens de referência (arquivo "Imagem do vigiatop.png" na pasta Vigiatop do Ewe) para a interface do sistema. Siga o layout, as cores, os menus e a organização das informações o mais de perto possível:

1. Dashboard (Visão Geral)
2. Clientes / Empresas
3. Câmeras
4. Ao Vivo (Visualização das Câmeras)
5. Gravações (Reprodução e Linha do Tempo)
6. Armazenamento e Servidores

Adapte as telas para computadores, tablets e celulares. As telas que não aparecem nas imagens devem seguir o mesmo padrão visual (menu lateral, cabeçalho, cartões, tabelas, filtros e badges de status). Isso vale para Usuários, Grupos/Locais, Eventos e Alertas, Servidores, Relatórios, Auditoria, Configurações, login e as telas do futuro app mobile.

As imagens são apenas referência visual. As regras de funcionamento vêm do documento técnico. Os números mostrados nas imagens são ilustrativos e não devem ser usados como dados reais. A marca exibida na interface é **TopCam** (a imagem mostra "VIGIA PRO" apenas como referência).

## Método de trabalho

1. Analise a especificação e apresente a arquitetura, a estrutura de diretórios, o modelo de dados e as dependências.
2. Aponte as dúvidas e incompatibilidades técnicas que precisam ser resolvidas antes da implementação.
3. Divida o desenvolvimento em fases pequenas, cada uma com uma entrega executável e critérios objetivos de aprovação.
4. Implemente a primeira fase de ponta a ponta, com código real, configurações, migrations, testes e instruções de execução.
5. Ao concluir cada fase, apresente os arquivos criados, os testes realizados, os resultados e as pendências antes de avançar.

## Prioridades do laboratório

- Receber cinco câmeras por RTMP, cada uma com uma chave exclusiva.
- Gravar continuamente apenas uma câmera, com retenção de 24 horas.
- Deixar as outras quatro somente para visualização ao vivo.
- Implementar autenticação, separação entre clientes e permissões individuais por câmera.
- Entregar o painel administrativo agora e o aplicativo mobile em uma fase posterior.
- Monitorar uso de disco, gravação, conectividade e falhas.
- Garantir que o sistema possa ser migrado para um servidor dedicado sem reescrever a aplicação.

Não presuma que a câmera TWG 6608 suporta RTMP ou um determinado codec sem validação. Preveja um transmissor RTMP de teste para que o desenvolvimento não dependa do equipamento físico no início.

Não afirme que uma funcionalidade está pronta sem implementá-la e testá-la. Quando um teste não puder ser executado, informe exatamente o que falta e forneça o procedimento de validação.

Comece apresentando o plano de execução e a primeira fase, sem tentar desenvolver a plataforma inteira em uma única resposta.
