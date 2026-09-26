#!/bin/sh
# Transmissor RTMP de teste: simula uma câmera sem depender do equipamento físico.
#
#   transmit.sh publish <CHAVE> [ROTULO]    → transmite para sempre; se cair, tenta de novo a cada 3 s
#   transmit.sh once <CHAVE> <SEGUNDOS>     → uma única tentativa por N segundos (sai com o código do ffmpeg)
#
# Variáveis: TX_URL (padrão rtmp://mediamtx:1935/live), TX_SIZE (640x360), TX_FPS (15),
#            TX_BITRATE (800k), TX_AUDIO (1 = AAC 64k; 0 = sem áudio), TX_CODEC (libx264)

set -u
MODE="${1:-}"
KEY="${2:-}"
TX_URL="${TX_URL:-rtmp://mediamtx:1935/live}"
TX_SIZE="${TX_SIZE:-640x360}"
TX_FPS="${TX_FPS:-15}"
TX_BITRATE="${TX_BITRATE:-800k}"
TX_AUDIO="${TX_AUDIO:-1}"
TX_CODEC="${TX_CODEC:-libx264}"

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
