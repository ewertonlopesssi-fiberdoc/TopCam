#!/usr/bin/env bash
# TopCam — troca (rotação) dos segredos do .env. Fase 8.
#
#   scripts/rotate-secrets.sh --all                 # todos os grupos
#   scripts/rotate-secrets.sh --jwt --media         # só alguns
#   scripts/rotate-secrets.sh --enc --yes           # sem pergunta de confirmação
#
# Grupos:
#   --jwt    JWT_SECRET. Logins continuam; quem estiver vendo ao vivo/gravação reabre o vídeo.
#   --media  MEDIA_HOOK_SECRET, MEDIA_READ_PASSWORD, MEDIA_GATEWAY_TOKEN (comunicação interna).
#            O servidor de mídia reinicia: câmeras reconectam sozinhas em segundos.
#   --db     POSTGRES_PASSWORD (dono do banco) e APP_DB_PASSWORD (aplicação).
#   --enc    STREAM_KEY_ENC_KEY: recifra no banco as chaves das câmeras, a senha do SMTP e as do backup
#            (uma transação: ou tudo, ou nada). As chaves RTMP das câmeras NÃO mudam.
#
# Segurança: cópia do .env antes (.env.antes-rotacao.<data>, só root lê); segredos nunca
# aparecem na tela, na linha de comando ou na auditoria (que registra só os grupos).
# Não rode junto com update.sh nem com os roteiros de aceite.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC2086
dc() { docker compose ${COMPOSE_ARGS:-} "$@"; }
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { echo "erro: $*" >&2; exit 1; }
rand() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
getv() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- | tr -d '"'; }
setv() {
  if grep -qE "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else printf '%s=%s\n' "$1" "$2" >>.env; fi
}
cli() { dc exec -T api node apps/api/dist/cli.js "$@"; }

JWT=0 MEDIA=0 DB=0 ENC=0 YES=0
[ $# -gt 0 ] || { sed -n '2,19p' "$0"; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --all) JWT=1 MEDIA=1 DB=1 ENC=1 ;;
    --jwt) JWT=1 ;;
    --media) MEDIA=1 ;;
    --db) DB=1 ;;
    --enc) ENC=1 ;;
    --yes|-y) YES=1 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) die "opção desconhecida: $1" ;;
  esac
  shift
done
GROUPS_=()
[ $JWT = 1 ] && GROUPS_+=(jwt)
[ $MEDIA = 1 ] && GROUPS_+=(media)
[ $DB = 1 ] && GROUPS_+=(db)
[ $ENC = 1 ] && GROUPS_+=(enc)
[ ${#GROUPS_[@]} -gt 0 ] || die "escolha ao menos um grupo (--jwt, --media, --db, --enc ou --all)"
NAMES=$(IFS=,; echo "${GROUPS_[*]}")

[ -f .env ] || die "arquivo .env não encontrado"
command -v openssl >/dev/null || die "openssl não encontrado"
LOCK=/tmp/topcam-rotate-secrets.lock
mkdir "$LOCK" 2>/dev/null || die "outra troca de segredos em andamento (se não houver, apague $LOCK)"
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

log "conferindo os serviços"
dc exec -T api wget -q -O /dev/null http://127.0.0.1:3000/health || die "a API não está respondendo; resolva antes de trocar segredos"

echo "Segredos a trocar: ${GROUPS_[*]}"
echo "Efeitos: reinício rápido de API, worker e gateway$([ $MEDIA = 1 ] && echo ", servidor de mídia (câmeras reconectam)")$([ $DB = 1 ] && echo ", banco (alguns segundos)")."
[ $JWT = 1 ] && echo "         quem estiver vendo ao vivo ou gravação precisa reabrir o vídeo (logins continuam)."
if [ $YES != 1 ]; then
  read -r -p "Continuar? (digite SIM) " ans
  [ "$(echo "$ans" | tr '[:lower:]' '[:upper:]' | tr -d '[:space:]')" = SIM ] || die "cancelado; nada foi alterado"
fi

TS=$(date +%Y%m%d%H%M%S)
BACKUP=".env.antes-rotacao.$TS"
(umask 077 && cp .env "$BACKUP")
log "cópia do .env: $BACKUP"

OLD_OWNER=$(getv POSTGRES_PASSWORD)
OLD_ENC=$(getv STREAM_KEY_ENC_KEY)
NEW_OWNER="" NEW_ENC=""

# ---------------------------------------------------------------- banco: dono
if [ $DB = 1 ]; then
  NEW_OWNER=$(rand 32)
  log "trocando a senha do dono do banco"
  printf "ALTER ROLE topcam_owner PASSWORD '%s';\n" "$NEW_OWNER" |
    dc exec -T postgres psql -U topcam_owner -d topcam -v ON_ERROR_STOP=1 -q -f - >/dev/null ||
    die "falha ao trocar a senha do dono; nada foi alterado"
fi

# ---------------------------------------------------------------- chave de cifra
if [ $ENC = 1 ]; then
  NEW_ENC=$(openssl rand -base64 32)
  # Guarda a chave nova antes de mexer no banco: se algo cair no meio, ela não se perde.
  (umask 077 && printf 'STREAM_KEY_ENC_KEY_NOVA=%s\nSTREAM_KEY_ENC_KEY_ANTIGA=%s\n' "$NEW_ENC" "$OLD_ENC" >".env.rotacao-pendente")
  log "parando o worker e o backup durante a recifragem"
  dc stop worker backup >/dev/null
  log "recifrando no banco (chaves das câmeras e senha do SMTP)"
  if ! printf '%s\n%s\n' "$OLD_ENC" "$NEW_ENC" | cli secrets:reencrypt; then
    # Primeiro desfaz a senha do dono; só então religa o worker (sem dependências, para
    # não rodar o migrate de novo).
    if [ $DB = 1 ]; then
      printf "ALTER ROLE topcam_owner PASSWORD '%s';\n" "$OLD_OWNER" |
        dc exec -T postgres psql -U topcam_owner -d topcam -v ON_ERROR_STOP=1 -q -f - >/dev/null || true
    fi
    dc up -d --no-deps worker backup >/dev/null 2>&1 ||
      echo "atenção: religue os serviços: docker compose up -d worker backup" >&2
    rm -f .env.rotacao-pendente
    die "recifragem falhou e foi desfeita; nenhum segredo foi trocado"
  fi
fi

# ---------------------------------------------------------------- grava o .env
[ $JWT = 1 ] && setv JWT_SECRET "$(rand 48)"
if [ $MEDIA = 1 ]; then
  setv MEDIA_HOOK_SECRET "$(rand 40)"
  setv MEDIA_READ_PASSWORD "$(rand 32)"
  setv MEDIA_GATEWAY_TOKEN "$(rand 40)"
fi
if [ $DB = 1 ]; then
  setv POSTGRES_PASSWORD "$NEW_OWNER"
  setv APP_DB_PASSWORD "$(rand 32)"
fi
[ $ENC = 1 ] && setv STREAM_KEY_ENC_KEY "$NEW_ENC"
chmod 600 .env
log ".env atualizado"

# ---------------------------------------------------------------- aplica
fail_apply() {
  dc ps || true
  echo >&2
  echo "Algum serviço não voltou saudável. Para voltar aos segredos anteriores:" >&2
  [ $ENC = 1 ] && echo "  (a chave antiga está em .env.rotacao-pendente; o banco já está na chave nova — me chame antes de restaurar)" >&2
  echo "  cp $BACKUP .env && docker compose up -d --wait" >&2
  exit 1
}
if [ $DB = 1 ]; then
  log "recriando o banco com a nova senha e aplicando a senha da aplicação"
  dc up -d --wait postgres >/dev/null 2>&1 || fail_apply
  dc run --rm migrate >/dev/null 2>&1 || fail_apply
fi
log "recriando os serviços"
dc up -d --wait >/dev/null 2>&1 || fail_apply

# ---------------------------------------------------------------- confere
if [ $ENC = 1 ]; then
  cli secrets:check || fail_apply
  rm -f .env.rotacao-pendente
fi
cli secrets:rotated --names "$NAMES" >/dev/null || log "aviso: não consegui registrar na auditoria"
dc ps --format '{{.Service}}: {{.Status}}'
log "segredos trocados: ${GROUPS_[*]}"
echo
echo "A cópia $BACKUP guarda os segredos ANTIGOS. Depois de conferir o painel e as câmeras,"
echo "apague-a: rm $BACKUP"
