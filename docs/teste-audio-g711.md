# Teste: áudio G.711 por RTMP (laboratório, 02/10/2026)

**Por que:** o Ewe perguntou se, trocando o áudio da câmera Intelbras de AAC para G.711 (G711A ou G711U), o ao vivo por WebRTC teria som, e o que aconteceria com o resto.

**Como foi feito**

- O transmissor de teste mandou H.264 + G.711 por RTMP para a CAM-001 do laboratório (MediaMTX 1.21.1), primeiro em A-law (G711A) e depois em µ-law (G711U).
- Cada parte foi conferida: entrada, WebRTC no Chrome, HLS, gravação, reprodução e download.

## Resultado

| Parte | G711A | G711U | Observação |
|---|---|---|---|
| Entrada RTMP | Aceita | Aceita | "2 tracks (H264, G711)" |
| Ao vivo WebRTC (painel) | **Com som** | **Com som** | Chrome recebeu e tocou PCMA/PCMU (nível de áudio > 0) |
| Ao vivo HLS (app hoje; painel ao ativar o som) | **Sem som** | **Sem som** | A lista do HLS só traz o vídeo |
| Gravação | Com som | Com som | O servidor grava o G.711 convertido em PCM (`ipcm`) dentro do MP4 |
| Reprodução das gravações no navegador | Com som | — | Chrome decodificou o áudio |
| Download MP4 | Só no Chrome | — | MP4 com áudio PCM. **No player do Windows e no celular, sem som** (teste do Ewe) |

## Teste do Ewe com o MP4 baixado (02/10)

O `teste-g711.mp4` **não tocou som** nem no Windows nem no celular. O áudio PCM dentro do MP4 só funciona no Chrome. Com G.711, o vídeo baixado ficaria sem som para o cliente.

## Decisão

**Manter AAC nas câmeras.** O ganho do G.711 (som no WebRTC) não compensa perder o som no HLS do app e nos downloads.

O caminho para ter ao vivo rápido no app é WebRTC sem som, trocando para HLS ao ligar o som, como o painel já faz.

## O que não deu para testar aqui

- **Firefox e Safari** no painel.
- A **câmera real** em G.711 por RTMP. O teste usou o transmissor.

## Se for adotar G.711

- O app precisa do WebRTC para ter som ao vivo (o HLS nunca terá som com G.711).
- Ajustar os avisos que hoje dizem "áudio não toca no navegador" para G.711:
  - `apps/api/src/routes/live.ts`;
  - `apps/worker/src/jobs/probe.ts`.
- Áudio de 8 kHz: qualidade de telefone, suficiente para câmera.
