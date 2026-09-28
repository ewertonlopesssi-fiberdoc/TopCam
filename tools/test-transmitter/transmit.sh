#!/bin/sh
# Transmissor RTMP de teste: simula uma câmera sem depender do equipamento físico.
#
#   transmit.sh publish <CHAVE> [ROTULO]    → transmite para sempre; se cair, tenta de novo a cada 3 s
#   transmit.sh once <CHAVE> <SEGUNDOS>     → uma única tentativa por N segundos (sai com o código do ffmpeg)
#
# Variáveis: TX_URL (padrão rtmp://mediamtx:1935/live), TX_SIZE (640x360), TX_FPS (15),
#            TX_BITRATE (800k), TX_AUDIO (1 = AAC 64k; 0 = sem áudio), TX_CODEC (libx264),
#            TX_CLOCK (1 = relógio no vídeo para medir a latência de ponta a ponta)
#
# TX_CLOCK=1 desenha no topo da imagem uma faixa com 24 blocos pretos/brancos: os
# milissegundos do relógio do servidor (módulo 2^24) no instante em que o quadro foi
# gerado. O teste do navegador lê os blocos do vídeo e compara com o próprio relógio:
# a diferença é a latência de ponta a ponta (geração → codificação → RTMP → servidor
# de mídia → gateway → navegador → tela). Transmissor e navegador precisam do mesmo
# relógio (mesma máquina ou NTP).

set -u
MODE="${1:-}"
KEY="${2:-}"
TX_URL="${TX_URL:-rtmp://mediamtx:1935/live}"
TX_SIZE="${TX_SIZE:-640x360}"
TX_FPS="${TX_FPS:-15}"
TX_BITRATE="${TX_BITRATE:-800k}"
TX_AUDIO="${TX_AUDIO:-1}"
TX_CODEC="${TX_CODEC:-libx264}"
TX_CLOCK="${TX_CLOCK:-0}"

# Faixa de 24 bits com o relógio (ms). O pts vira o relógio real (RTCTIME) só para
# desenhar e volta a começar do zero antes de codificar.
clock_filter() {
  bw=$(( ${TX_SIZE%x*} / 25 ))
  f="settb=1/1000000,setpts=RTCTIME,drawbox=x=0:y=0:w=iw:h=24:color=black:t=fill"
  i=0
  while [ $i -lt 24 ]; do
    f="$f,drawbox=x=$((i * bw + bw / 2)):y=2:w=$bw:h=20:color=white:t=fill:enable='mod(floor(t*1000/pow(2\,$i))\,2)'"
    i=$((i + 1))
  done
  echo "$f,setpts=PTS-STARTPTS"
}

if [ -z "$MODE" ] || [ -z "$KEY" ]; then
  echo "uso: transmit.sh publish <chave> [rótulo] | once <chave> <segundos>" >&2
  exit 2
fi

run_ffmpeg() {
  duration="$1"
  set -- -hide_banner -loglevel warning -re \
    -f lavfi -i "testsrc2=size=${TX_SIZE}:rate=${TX_FPS}"
  if [ "$TX_AUDIO" = "1" ]; then
    set -- "$@" -f lavfi -i "sine=frequency=440:sample_rate=44100"
  fi
  if [ -n "$duration" ]; then
    set -- "$@" -t "$duration"
  fi
  if [ "$TX_CLOCK" = "1" ]; then
    set -- "$@" -vf "$(clock_filter)"
  fi
  set -- "$@" -c:v "$TX_CODEC" -preset veryfast -tune zerolatency -pix_fmt yuv420p \
    -b:v "$TX_BITRATE" -maxrate "$TX_BITRATE" -bufsize "$TX_BITRATE" -g "$((TX_FPS * 2))"
  if [ "$TX_AUDIO" = "1" ]; then
    set -- "$@" -c:a aac -b:a 64k
  fi
  ffmpeg "$@" -f flv "${TX_URL}/${KEY}"
}

case "$MODE" in
  publish)
    LABEL="${3:-camera}"
    echo "[tx:${LABEL}] transmitindo para ${TX_URL}/$(echo "$KEY" | cut -c1-4)… (${TX_SIZE}@${TX_FPS}fps ${TX_BITRATE})"
    trap 'echo "[tx:${LABEL}] encerrado"; exit 0' INT TERM
    while true; do
      run_ffmpeg ""
      echo "[tx:${LABEL}] conexão encerrada (código $?); nova tentativa em 3 s"
      sleep 3
    done
    ;;
  once)
    SECS="${3:-10}"
    run_ffmpeg "$SECS"
    ;;
  *)
    echo "modo inválido: $MODE" >&2
    exit 2
    ;;
esac
