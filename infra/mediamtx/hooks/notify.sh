#!/bin/sh
# Notifica a API sobre eventos do MediaMTX.
# Uso (pelo MediaMTX): notify.sh online|offline|segment_create|segment_complete
# Variáveis fornecidas pelo MediaMTX: MTX_PATH, MTX_SOURCE_TYPE, MTX_SOURCE_ID,
#   MTX_SEGMENT_PATH e MTX_SEGMENT_DURATION (eventos de gravação).
# Variáveis do contêiner: MEDIA_HOOK_SECRET, TOPCAM_API_URL.
#
# Se a API estiver fora do ar, o worker ainda indexa os segmentos pela varredura
# periódica da pasta de gravações; nada se perde.

EVENT="$1"
case "$EVENT" in
  online|offline)
    BODY=$(printf '{"path":"%s","source_type":"%s","source_id":"%s"}' \
      "$MTX_PATH" "${MTX_SOURCE_TYPE:-}" "${MTX_SOURCE_ID:-}")
    ;;
  segment_create|segment_complete)
    BODY=$(printf '{"path":"%s","segment_path":"%s","segment_duration":"%s"}' \
      "$MTX_PATH" "${MTX_SEGMENT_PATH:-}" "${MTX_SEGMENT_DURATION:-}")
    ;;
  *) echo "notify.sh: evento inválido: $EVENT" >&2; exit 2 ;;
esac

URL="${TOPCAM_API_URL:-http://api:3000}/internal/mediamtx/hooks/${EVENT}?secret=${MEDIA_HOOK_SECRET}"

i=0
while [ "$i" -lt 5 ]; do
  if wget -q -O /dev/null -T 5 --header "Content-Type: application/json" --post-data "$BODY" "$URL"; then
    exit 0
  fi
  i=$((i + 1))
  sleep 2
done
echo "notify.sh: falha ao notificar a API ($EVENT)" >&2
exit 1
