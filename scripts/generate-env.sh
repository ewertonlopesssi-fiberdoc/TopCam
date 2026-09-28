#!/usr/bin/env bash
# Gera o arquivo .env a partir do .env.example com segredos aleatórios.
# Uso: scripts/generate-env.sh [--public-host video.seudominio.com.br] [--admin-email admin@...] [--force]
#      scripts/generate-env.sh --add-missing   → acrescenta ao .env existente as variáveis
#                                                novas de versões mais recentes (não altera as atuais)
set -euo pipefail
cd "$(dirname "$0")/.."

PUBLIC_HOST_ARG="" ADMIN_EMAIL_ARG="" FORCE=0 ADD_MISSING=0
while [ $# -gt 0 ]; do
  case "$1" in
    --public-host) PUBLIC_HOST_ARG="$2"; shift 2 ;;
    --admin-email) ADMIN_EMAIL_ARG="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --add-missing) ADD_MISSING=1; shift ;;
    *) echo "opção desconhecida: $1" >&2; exit 2 ;;
  esac
done

rand() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c "$1"; }

if [ "$ADD_MISSING" -eq 1 ]; then
  [ -f .env ] || { echo "Não existe .env; rode sem --add-missing." >&2; exit 1; }
  added=0
  while IFS= read -r line; do
    case "$line" in ''|\#*) continue ;; esac
    var="${line%%=*}"
    grep -q "^${var}=" .env && continue
    case "$var" in
      JWT_SECRET) value="$(rand 48)" ;;
      *) value="${line#*=}" ;;
    esac
    printf '%s=%s\n' "$var" "$value" >> .env
    echo "acrescentado: $var"
    added=$((added + 1))
  done < .env.example
  echo "$added variável(is) acrescentada(s) ao .env"
  exit 0
fi

if [ -f .env ] && [ "$FORCE" -ne 1 ]; then
  echo "O arquivo .env já existe. Use --force para sobrescrever (os segredos atuais serão perdidos)." >&2
  exit 1
fi
command -v openssl >/dev/null || { echo "openssl não encontrado" >&2; exit 1; }

cp .env.example .env
set_var() { sed -i "s|^$1=.*|$1=$2|" .env; }
set_var POSTGRES_PASSWORD "$(rand 32)"
set_var APP_DB_PASSWORD "$(rand 32)"
set_var MEDIA_HOOK_SECRET "$(rand 40)"
set_var MEDIA_READ_PASSWORD "$(rand 32)"
set_var JWT_SECRET "$(rand 48)"
set_var STREAM_KEY_ENC_KEY "$(openssl rand -base64 32)"
set_var ADMIN_INITIAL_PASSWORD "$(rand 20)"
[ -n "$PUBLIC_HOST_ARG" ] && set_var PUBLIC_HOST "$PUBLIC_HOST_ARG"
[ -n "$ADMIN_EMAIL_ARG" ] && set_var ADMIN_EMAIL "$ADMIN_EMAIL_ARG"
chmod 600 .env
echo ".env criado (permissão 600). Guarde uma cópia segura de STREAM_KEY_ENC_KEY e da senha inicial do administrador."
