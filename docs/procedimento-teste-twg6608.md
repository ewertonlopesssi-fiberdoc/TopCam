# Procedimento — validação da câmera TWG 6608 (dúvida D1)

Objetivo: confirmar, **antes de depender dela**, se a TWG 6608 envia vídeo por RTMP push e com qual codec, resolução, taxa de quadros, bitrate e áudio. Nada aqui altera a plataforma. A câmera é tratada como qualquer outra câmera de teste.

## Pré-requisitos

- TopCam da Fase 1 rodando (`docker compose ps` com todos os serviços saudáveis).
- A câmera precisa alcançar a porta **1935/tcp** da VM (pela rede local ou pelo IP público com encaminhamento).
- Acesso à interface web da câmera.

## 1. Verificar a interface da câmera

Procure uma das opções: **RTMP**, "Live", "Plataforma", "Streaming", "Push" ou "Servidor de transmissão". Anote:

| Item | Resposta |
|---|---|
| Existe RTMP push? | sim / não |
| Campos | URL + chave separadas / URL única |
| Aceita RTMPS? | sim / não |
| Codec de vídeo configurável | H.264 / H.265 / outro |
| Áudio | AAC / G.711 / sem áudio / configurável? |
| Resolução, fps e bitrate configuráveis? | valores disponíveis |
| Stream principal ou secundário no RTMP? | |
| Firmware | versão |

**Se não houver RTMP:** pare aqui e me informe. A plataforma já tem o campo `ingest_protocol = rtsp_pull` reservado. Nesse caso, avaliamos a entrada por RTSP pull como escopo novo.

## 2. Configurar a câmera

Pegue os dados de uma câmera cadastrada (use a CAM-005 da Empresa Alfa para o teste):

```bash
docker compose exec api node apps/api/dist/cli.js camera:show-key --tenant empresa-alfa --code CAM-005
```

Na câmera, preencha:

- **URL:** `rtmp://<IP-ou-host-da-VM>:1935/live`
- **Chave:** a chave exibida
- Se o campo for único: `rtmp://<IP-ou-host-da-VM>:1935/live/<CHAVE>`

Configuração recomendada para o teste: **H.264**, 1280x720 ou 1920x1080, 15–25 fps, 1–2 Mbps, GOP (intervalo de I-frame) de 2 s e áudio **AAC** ou desligado.

## 3. Acompanhar o resultado

```bash
docker compose exec api node apps/api/dist/cli.js camera:list --tenant empresa-alfa
docker compose exec postgres psql -U topcam_owner -d topcam -c \
  "SELECT occurred_at, type, message FROM camera_events
    WHERE camera_id = (SELECT id FROM cameras WHERE code = 'CAM-005'
                         AND tenant_id = (SELECT id FROM tenants WHERE slug = 'empresa-alfa'))
    ORDER BY id DESC LIMIT 15"
docker compose logs --since 5m mediamtx | grep -i -E "rtmp|live/"
```

| O que aparece | Significado |
|---|---|
| Estado `ao_vivo` e evento `codec_detected` com o codec, a resolução e o fps | ✅ Funciona. Anote os valores |
| `codec_warning` sobre H.265 | Funciona, mas o navegador pode não reproduzir. Prefira H.264 |
| `codec_warning` sobre áudio (ex.: `pcm_alaw`) | Funciona. Desligue o áudio ou mude para AAC |
| `probe_failed` com `codec_unsupported` | A câmera envia um codec que não aceitamos |
| Nenhum evento e nada nos logs do MediaMTX | A câmera não chegou à porta 1935 (rede/firewall) ou a URL está errada |
| `auth_rejected` | A chave ou o formato da URL está errado (ex.: a câmera acrescenta sufixos à chave) |

## 4. Medir o bitrate real (importante para os 24 h de gravação)

Com a câmera `ao_vivo` por 5 minutos:

```bash
docker compose exec postgres psql -U topcam_owner -d topcam -Atc \
  "SELECT bitrate_kbps FROM cameras WHERE code = 'CAM-005'
     AND tenant_id = (SELECT id FROM tenants WHERE slug = 'empresa-alfa')"
```

A ocupação estimada em 24 h é **bitrate_kbps × 10,8 MB** (ex.: 2000 kbps ≈ 21,6 GB). O disco de vídeo de 35 GB comporta até cerca de 2 Mbps dentro do primeiro alerta (70%).

## 5. Enviar o resultado

Envie a tabela do item 1, a saída de `camera:list` e os eventos do item 3. Com isso fecho a D1 e ajusto as recomendações da Fase 3 (ao vivo) e da Fase 4 (gravação).
