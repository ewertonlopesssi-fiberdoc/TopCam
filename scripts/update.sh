#!/usr/bin/env bash
# TopCam — atualiza uma instalação existente numa única sequência.
#
#   scripts/update.sh                         # git pull do GitHub (origin/main)
#   scripts/update.sh --bundle /root/x.bundle # atualização entregue como arquivo .bundle
#   scripts/update.sh --no-pull               # só aplica o que já está na pasta
#
# Passos: pull → variáveis novas no .env → build e subida → recria gateway/MediaMTX
# se a configuração deles mudou → espera todos ficarem saudáveis.
#
# Por que recriar: o Compose não recria um contêiner quando só muda um arquivo de
# configuração montado (Caddyfile, mediamtx.yml). O gateway já recarrega sozinho
# (caddy --watch), mas recriar garante a configuração nova também em instalações
# antigas. Recriar o MediaMTX derruba as câmeras por alguns segundos; elas
# reconectam sozinhas.

set -euo pipefail
cd "$(dirname "$0")/.."

BUNDLE=""
PULL=1
while [ $# -gt 0 ]; do
  case "$1" in
    --bundle) BUNDLE="$2"; shift 2 ;;
    --no-pull) PULL=0; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "opção desconhecida: $1" >&2; exit 2 ;;
  esac
done

# shellcheck disable=SC2086
dc() { docker compose ${COMPOSE_ARGS:-} "$@"; }
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

[ -f .env ] || { echo "Arquivo .env não encontrado. Para instalar do zero, veja o README." >&2; exit 2; }
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Há alterações locais nos arquivos do projeto:" >&2
  git status --short --untracked-files=no >&2
  echo "Guarde-as (git stash) ou descarte-as antes de atualizar." >&2
  exit 1
fi

OLD=$(git rev-parse HEAD)
if [ "$PULL" = 1 ]; then
  if [ -n "$BUNDLE" ]; then
    log "aplicando $BUNDLE"
    git pull --ff-only "$BUNDLE" main
  else
    log "baixando do GitHub"
    git pull --ff-only
  fi
fi
NEW=$(git rev-parse HEAD)
log "versão: ${OLD:0:7} → ${NEW:0:7}"

log "variáveis novas no .env (as atuais não mudam)"
scripts/generate-env.sh --add-missing

log "construindo e subindo (pode levar alguns minutos)"
dc up -d --build --remove-orphans

RECREATE=()
if [ "$OLD" != "$NEW" ]; then
  CHANGED=$(git diff --name-only "$OLD" "$NEW")
  grep -q '^infra/caddy/' <<<"$CHANGED" && RECREATE+=(gateway)
  grep -q '^infra/mediamtx/' <<<"$CHANGED" && RECREATE+=(mediamtx)
fi
if [ ${#RECREATE[@]} -gt 0 ]; then
  log "configuração alterada; recriando: ${RECREATE[*]}"
  dc up -d --force-recreate --no-deps "${RECREATE[@]}"
fi

log "aguardando os serviços ficarem saudáveis"
if ! dc up -d --wait >/dev/null 2>&1; then
  dc ps
  echo "Algum serviço não ficou saudável. Veja: docker compose logs <serviço>" >&2
  exit 1
fi
dc ps
log "atualização concluída"
