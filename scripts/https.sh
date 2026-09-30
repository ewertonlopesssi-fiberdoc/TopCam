#!/usr/bin/env bash
# TopCam — liga o HTTPS do painel (certificado automático Let's Encrypt).
#
#   scripts/https.sh --domain topcam.suportinet.com.br [--webrtc-host 172.31.141.20]
#   scripts/https.sh --rtmps on|off     # RTMPS na 1936 (só depois do certificado emitido)
#   scripts/https.sh --status
#   scripts/https.sh --off              # volta o painel para HTTP na porta 80
#
# Requisitos para o certificado sair: o domínio aponta (DNS tipo A) para um IP deste
# servidor e as portas 80 e 443 desse IP estão acessíveis pela internet.
# Depois de ligado, qualquer acesso por http:// (inclusive pelo IP) é redirecionado para
# https://<domínio>. As câmeras continuam em rtmp://<IP ou domínio>:1935 sem mudança.
set -euo pipefail
cd "$(dirname "$0")/.."
dc() { docker compose ${COMPOSE_ARGS:-} "$@"; }

[ -f .env ] || { echo "Não existe .env (rode scripts/generate-env.sh)." >&2; exit 1; }
getv() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- | tr -d '"'; }
setv() {
  if grep -qE "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else printf '%s=%s\n' "$1" "$2" >>.env; fi
}

DOMAIN="" WEBRTC_EXTRA="" MODE="" RTMPS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; MODE=on; shift 2 ;;
    --webrtc-host) WEBRTC_EXTRA="$2"; shift 2 ;;
    --off) MODE=off; shift ;;
    --rtmps) RTMPS="$2"; shift 2 ;;
    --status) MODE=status; shift ;;
    *) echo "opção desconhecida: $1" >&2; exit 2 ;;
  esac
done

show_status() {
  local site; site=$(getv SITE_ADDRESS)
  echo "Painel:        $([[ "$site" == :* || -z "$site" ]] && echo "HTTP (porta 80)" || echo "https://$site")"
  echo "PUBLIC_HOST:   $(getv PUBLIC_HOST)"
  echo "PANEL_URL:     $(getv PANEL_URL)"
  echo "Cookie seguro: $(getv COOKIE_SECURE)"
  echo "WebRTC:        $(getv WEBRTC_HOSTS)"
  echo "RTMPS (1936):  $(getv RTMP_ENCRYPTION)"
  if [[ -n "$site" && "$site" != :* ]]; then
    if dc exec -T gateway sh -c "ls /data/caddy/certificates/*/$site/$site.crt" >/dev/null 2>&1; then
      echo "Certificado:   emitido"
      echo | timeout 10 openssl s_client -connect 127.0.0.1:"$(p=$(getv HTTPS_PORT); echo "${p:-443}")" \
        -servername "$site" 2>/dev/null | openssl x509 -noout -issuer -enddate 2>/dev/null | sed 's/^/               /'
    else
      echo "Certificado:   ainda não emitido (veja: docker compose logs gateway | grep -i -E 'certificate|acme|error')"
    fi
  fi
}

recreate() {
  echo "Recriando os serviços com a nova configuração…"
  dc up -d --no-deps gateway api worker web mediamtx
  for i in $(seq 1 30); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$(dc ps -q gateway)" 2>/dev/null)" = healthy ] && break
    sleep 2
  done
}

case "$MODE" in
  status) show_status; exit 0 ;;
  on)
    [[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] ||
      { echo "Domínio inválido: $DOMAIN" >&2; exit 1; }
    # DNS: o domínio precisa apontar para um IP deste servidor.
    ip=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}')
    if [ -z "$ip" ]; then
      echo "O domínio $DOMAIN não resolve. Crie o registro A no DNS antes." >&2; exit 1
    fi
    if ip -4 addr show 2>/dev/null | grep -qw "inet $ip"; then
      echo "DNS ok: $DOMAIN → $ip (IP deste servidor)"
    else
      echo "Atenção: $DOMAIN → $ip, que não aparece nas interfaces deste servidor."
      echo "Se houver NAT/roteamento para cá, tudo bem; senão, o certificado não será emitido."
    fi
    lan=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')
    hosts="$DOMAIN"
    for h in $WEBRTC_EXTRA $lan; do [[ ",$hosts," == *",$h,"* ]] || hosts="$hosts,$h"; done
    cp .env ".env.antes-https.$(date +%Y%m%d%H%M%S)"
    setv PUBLIC_HOST "$DOMAIN"
    setv SITE_ADDRESS "$DOMAIN"
    setv HTTP_REDIRECT_ADDRESS "http://"
    setv PANEL_URL "https://$DOMAIN"
    setv COOKIE_SECURE true
    setv WEBRTC_HOSTS "$hosts"
    recreate
    echo
    echo "Aguardando o certificado (até 2 min)…"
    for i in $(seq 1 24); do
      dc exec -T gateway sh -c "ls /data/caddy/certificates/*/$DOMAIN/$DOMAIN.crt" >/dev/null 2>&1 && break
      sleep 5
    done
    show_status
    echo
    echo "Pronto: https://$DOMAIN . Faça login de novo (o cookie agora é só HTTPS)."
    echo "Para o RTMPS, depois do certificado emitido: scripts/https.sh --rtmps on"
    ;;
  off)
    cp .env ".env.antes-http.$(date +%Y%m%d%H%M%S)"
    setv SITE_ADDRESS ":80"
    setv HTTP_REDIRECT_ADDRESS "http://redirecionamento.invalid"
    setv PANEL_URL ""
    setv COOKIE_SECURE false
    setv RTMP_ENCRYPTION no
    recreate
    show_status
    ;;
  "")
    [ -n "$RTMPS" ] || { sed -n '2,13p' "$0"; exit 2; }
    ;;
esac

if [ -n "$RTMPS" ]; then
  case "$RTMPS" in
    on)
      if [ ! -s .data/tls/server.crt ] || [ ! -s .data/tls/server.key ]; then
        echo "O certificado ainda não foi copiado para .data/tls." >&2
        echo "Ele é copiado pelo serviço do host (topcam-host) a cada minuto depois de emitido;" >&2
        echo "se o serviço não estiver instalado, rode como root: topcam-host sync" >&2
        exit 1
      fi
      setv RTMP_ENCRYPTION optional ;;
    off) setv RTMP_ENCRYPTION no ;;
    *) echo "use --rtmps on ou --rtmps off" >&2; exit 2 ;;
  esac
  dc up -d --no-deps mediamtx
  echo "RTMPS: $(getv RTMP_ENCRYPTION) — câmeras podem usar rtmps://$(getv PUBLIC_HOST):$(p=$(getv RTMPS_PUBLIC_PORT); echo "${p:-1936}")/live/<chave>"
fi
