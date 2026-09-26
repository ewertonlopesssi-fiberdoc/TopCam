# Especificação técnica — Projeto piloto de câmeras (TopCam)

> Fonte: projeto_piloto_cameras.docx (convertido para Markdown em 2026-09-26). Documento principal de regras de funcionamento.

Objetivo: iniciar em uma VM Proxmox com disco de 50 GB, visualizar até
cinco câmeras no laboratório e gravar somente uma por 24 horas;
posteriormente migrar para servidor físico dedicado e ampliar a
capacidade.

## 1. Escopo e premissas do laboratório

- Uma VM Debian no Proxmox executará API, painel, banco, fila, servidor
  de mídia e trabalhadores em contêineres Docker Compose; os serviços
  serão isolados logicamente para migração futura.

- Até cinco câmeras de teste: uma habilitada para gravação contínua e as
  demais somente para transmissão ao vivo, sem segmentos persistentes.

- Retenção inicial: 24 horas para a câmera gravada. Permitir retenção
  configurável por câmera no produto final, com limites por plano e
  capacidade.

- Entrada principal por RTMP push: cada câmera recebe endereço do
  servidor e chave de transmissão exclusiva. Confirmar no equipamento
  TWG 6608 a existência e a compatibilidade dessa função antes de
  depender dela.

- Não incluir cadastro em massa na primeira versão. O cadastro será
  individual, vinculado a cliente, local e grupo.

## 2. Infraestrutura inicial

| Recurso         | Recomendação inicial                                                             |
|-----------------|----------------------------------------------------------------------------------|
| Hipervisor      | Proxmox VE existente                                                             |
| Máquina virtual | Debian 12 ou versão estável homologada; 4–6 vCPU; 8–12 GB RAM                    |
| Disco virtual   | 50 GB SSD, preferencialmente thin provisioned com alertas e reserva real no host |
| Rede            | VirtIO; IP fixo; firewall; portas RTMP/RTMPS, HTTPS e administração restrita     |
| Backup          | Backup da VM e dump PostgreSQL em armazenamento EXTERNO à VM                     |
| Capacidade      | 5 streams de teste, 1 gravação contínua; sem transcodificação por padrão         |

Estimativa para 1 câmera a 2 Mbps: 21,6 GB por 24 horas (decimal), antes
de áudio, picos de bitrate e overhead. Em disco total de 50 GB, reservar
aproximadamente 12–18 GB para sistema, contêineres, banco, logs e
margem; impor quota de vídeo e alertas. Se o consumo real impedir a
retenção de 24 h com segurança, usar bitrate menor ou adicionar volume
de vídeo separado. Não prometer 24 h a qualquer bitrate.

## 3. Arquitetura lógica e serviços

| Camada                   | Tecnologia / responsabilidade                                                           |
|--------------------------|-----------------------------------------------------------------------------------------|
| Interface administrativa | React/Next.js; dashboard, clientes, câmeras, permissões e auditoria                     |
| API e autenticação       | Node.js + TypeScript; autenticação, autorização multi-tenant, chaves RTMP e APIs do app |
| Banco                    | PostgreSQL: clientes, câmeras, segmentos, usuários, permissões, eventos                 |
| Fila / eventos           | Redis no piloto; tarefas críticas com estado durável no PostgreSQL                      |
| Recepção de vídeo        | MediaMTX ou componente equivalente, com autenticação por publish e monitoramento        |
| Gravação                 | Segmentos curtos via remux/stream copy quando compatível; indexação transacional        |
| Ao vivo                  | HLS ou WebRTC via gateway/API, com URLs temporárias; testar compatibilidade H.264/H.265 |
| Operação                 | Docker Compose, health checks, métricas, logs rotativos e alertas                       |

Fluxo: câmera → RTMP push → servidor de mídia → (a) reprodução
autorizada ao vivo; (b) somente para câmera autorizada, gravador →
segmentos → índice PostgreSQL → limpeza após 24 horas. Não
transcodificar continuamente por padrão. RTMP/H.265 e reprodução em
navegador/celular exigem testes reais; H.264 é alternativa de
compatibilidade.

## 4. Funcionalidades do produto

- Administrador da plataforma: gerenciar clientes, locais, grupos,
  câmeras, usuários, servidores, retenção, capacidade e auditoria.

- Cliente: visualizar apenas câmeras e gravações explicitamente
  autorizadas; papéis distintos para administrador do cliente, operador
  e visualizador.

- Cadastro individual de câmera: cliente, local, grupo, nome, habilitar
  gravação, retenção, chave RTMP gerada e status. Não exigir IP da
  câmera nem senha RTSP no fluxo RTMP push.

- Estados: aguardando transmissão, conectando, recebendo, validando, ao
  vivo e gravando. Só exibir “gravando” após o primeiro segmento durável
  confirmado.

- Painel: visão geral, mosaico ao vivo, linha do tempo, calendário,
  download autorizado, alertas, armazenamento, servidores e trilha de
  auditoria.

- Aplicativo mobile: login e senha, grupos, ao vivo, reprodução da
  câmera gravada, eventos e conta; acesso sempre mediado pela API.

- Segurança: TLS/HTTPS, RTMPS se a câmera suportar, chaves longas
  rotacionáveis, autenticação de publicação, controle por tenant, rate
  limiting, backups e URLs assinadas para playback.

## 5. Regras específicas do teste

| Câmera        | Modo                        | Retenção                     |
|---------------|-----------------------------|------------------------------|
| Câmera 01     | Ao vivo + gravação contínua | 24 horas                     |
| Câmeras 02–05 | Somente ao vivo             | Nenhuma gravação persistente |

- Se uma câmera de visualização cair, registrar o evento e tentar
  reconexão quando ela voltar a publicar; não iniciar gravação
  acidentalmente.

- A câmera gravada deve criar segmentos indexados, exibir lacunas de
  sinal, permitir reprodução e eliminar os arquivos expirados.

- Separar last_video_at de last_durable_segment_at; não confundir
  “online” com “gravando”.

- Impor limite de espaço para vídeos, rotação de logs e alertas em 70%,
  85% e 95% do disco; parar gravação de forma controlada se faltar
  espaço, preservando banco e sistema.

## 6. Modelo mínimo de dados

Tabelas sugeridas: tenants, users, roles, user_camera_permissions,
locations, camera_groups, cameras, ingest_nodes, storage_nodes,
recording_segments, camera_events, audit_logs e retention_policies.
Segments: tenant_id, camera_id, início/fim UTC, codec, tamanho,
checksum, storage_id, caminho, expires_at, estado e created_at. Aplicar
tenant_id em toda consulta de negócio e auditar exportações.

## 7. Critérios de aceite do piloto

- Cadastrar cinco câmeras individualmente e publicar usando chaves
  exclusivas; rejeitar chaves inválidas e publicações simultâneas
  indevidas.

- Exibir as cinco ao vivo (conforme capacidade real da câmera e
  compatibilidade de codecs), inclusive no aplicativo.

- Gravar somente a câmera 01 por 24 horas, reproduzir trechos e exportar
  MP4 autorizado.

- Demonstrar que as outras quatro não possuem arquivos persistentes nem
  entradas de segmentos.

- Confirmar limpeza automática após 24 horas, recuperação após queda de
  sinal, eventos e timeline com lacunas.

- Validar isolamento entre dois clientes fictícios e permissões
  distintas de usuários.

- Executar testes de reinício de contêiner e VM, restauração de backup,
  falta de espaço e métricas por 7 dias.

## 8. Migração para servidor dedicado

- Manter hostname público estável desde o piloto (ex.:
  video.seudominio.com); evitar IP físico embutido no aplicativo e nas
  configurações de câmera.

- Separar configurações por variáveis de ambiente e volumes nomeados;
  manter scripts versionados, migrations de banco e infraestrutura como
  código.

- No novo servidor: instalar Proxmox ou Debian dedicado, preparar SSDs
  para sistema, pool protegido para gravações, rede 10/25 GbE conforme
  carga e backups externos.

- Realizar dump consistente do PostgreSQL, backup das
  configurações/segredos e cópia dos segmentos que precisem ser
  preservados; restaurar e validar antes de trocar DNS/VIP.

- Agendar janela de migração: RTMP reconecta, podendo haver breve
  lacuna; não prometer migração sem interrupção.

- Para futura meta de 800 câmeras a 2 Mbps e 3 dias: aproximadamente 1,6
  Gbps de entrada e 51,84 TB de vídeo, antes de paridade, picos,
  espectadores e margem. Dimensionar com medições do piloto.

## 9. Pendências a confirmar antes da instalação

- Modelo exato, CPU e memória efetivamente disponíveis no host Proxmox;
  50 GB livres reais e SSD saudável.

- Compatibilidade da TWG 6608 com RTMP push e codec/bitrate
  configurável; confirmar acesso à interface de cada câmera.

- IP público, DNS e política de encaminhamento de portas; se câmeras
  estiverem na rede do ISP, definir caminho privado preferencial.

- Escolha inicial entre painel web responsivo e app mobile nativo; ambos
  permanecem no escopo, mas podem ser entregues em fases.

- Política de backup externo e quem administrará as credenciais e o
  domínio.

Decisão de implementação: priorizar funcionamento ponta a ponta com 1
câmera gravando e 4 ao vivo. Não otimizar prematuramente para 800
streams na VM de 50 GB; preservar interfaces e separação de serviços
para escalar depois.
