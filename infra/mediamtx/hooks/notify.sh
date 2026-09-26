#!/bin/sh
# Notifica a API sobre mudanças de estado de um caminho do MediaMTX.
# Uso (pelo MediaMTX): notify.sh online|offline
# Variáveis fornecidas pelo MediaMTX: MTX_PATH, MTX_SOURCE_TYPE, MTX_SOURCE_ID.
# Variáveis do contêiner: MEDIA_HOOK_SECRET, TOPCAM_API_URL.

EVENT="$1"
case "$EVENT" in
  online|offline) ;;
  *) echo "notify.sh: evento inválido: $EVENT" >&2; exit 2 ;;
esac

BODY=$(printf '{"path":"%s","source_type":"%s","source_id":"%s"}' \
  "$MTX_PATH" "${MTX_SOURCE_TYPE:-}" "${MTX_SOURCE_ID:-}")
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
