#!/usr/bin/env bash
# TopCam — restauração de um backup (Fase 8). Rode como root em /opt/topcam.
#
#   scripts/restore.sh --file /root/topcam-20261001-033000.tar.gpg
#   scripts/restore.sh --file X --public-host 172.31.141.50   # VM de teste: painel em HTTP
#                                                              # nesse IP e backup automático DESLIGADO
#   scripts/restore.sh --file X --check                        # só abre e mostra o conteúdo
#
# O que faz:
#   1. pede a senha do backup, abre e confere o arquivo (nada muda até aqui);
#   2. mostra data, versão e contagens e pede confirmação (digite RESTAURAR);
#   3. guarda o .env atual (.env.antes-restauracao.<data>) e coloca o do backup;
#   4. para os serviços, recria o banco "topcam" a partir do dump, ajusta as senhas do banco,
#      aplica migrations mais novas (se houver) e sobe tudo;
#   5. confere se as chaves das câmeras abrem (secrets:check).
# Gravações de vídeo não fazem parte do backup.
#
# Em outra VM: instale o TopCam normalmente (clone + scripts/generate-env.sh + docker compose
# up -d --build) e só depois restaure. O firewall do host (topcam-host) é instalado à parte.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC2086
dc() { docker compose ${COMPOSE_ARGS:-} "$@"; }
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { echo "erro: $*" >&2; exit 1; }
setv() {
  if grep -qE "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else printf '%s=%s\n' "$1" "$2" >>.env; fi
}
getv() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- | tr -d '"'; }

FILE="" LAB_HOST="" CHECK=0 YES=0 PASSFILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --file) FILE="$2"; shift 2 ;;
    --public-host) LAB_HOST="$2"; shift 2 ;;
    --check) CHECK=1; shift ;;
    --yes) YES=1; shift ;;
    --passphrase-file) PASSFILE="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "opção desconhecida: $1" ;;
  esac
done
[ -n "$FILE" ] || { sed -n '2,20p' "$0"; exit 2; }
[ -f "$FILE" ] || die "arquivo não encontrado: $FILE"
[ -f .env ] || die "instale o TopCam antes (falta o .env); veja o comentário no início deste script"
[ "$(id -u)" = 0 ] || die "rode como root"

WORK=$(mktemp -d /tmp/topcam-restore.XXXXXX)
chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT
cp "$FILE" "$WORK/backup.tar.gpg"

if [ -n "$PASSFILE" ]; then
  cp "$PASSFILE" "$WORK/pp"
else
  read -r -s -p "Senha do backup: " PP; echo
  printf '%s' "$PP" >"$WORK/pp"; unset PP
fi
chmod 600 "$WORK/pp"

log "abrindo o arquivo"
# A imagem do backup tem gpg e pg_restore; roda como root só para ler/gravar a pasta de trabalho.
tool() { docker run --rm -i --user 0 --network none -v "$WORK:/w" --entrypoint sh "topcam/backup:$(getv TOPCAM_VERSION | sed 's/^$/0.1.0/')" -c "$1"; }
docker image inspect "topcam/backup:$(getv TOPCAM_VERSION | sed 's/^$/0.1.0/')" >/dev/null 2>&1 ||
  { log "construindo a imagem de backup"; dc build backup >/dev/null; }
tool 'export GNUPGHOME=$(mktemp -d); gpg --batch --pinentry-mode loopback --passphrase-file /w/pp -o /w/backup.tar -d /w/backup.tar.gpg 2>/w/gpg.err && mkdir -p /w/out && tar -xf /w/backup.tar -C /w/out && rm -f /w/backup.tar' ||
  die "não foi possível abrir: senha errada ou arquivo danificado ($(tail -1 "$WORK/gpg.err" 2>/dev/null))"
for f in manifest.json topcam.dump topcam.env; do [ -s "$WORK/out/$f" ] || die "backup incompleto: falta $f"; done
tool 'pg_restore --list /w/out/topcam.dump >/dev/null' || die "o dump do banco está danificado"

tool 'node -e "
const m = JSON.parse(require(\"fs\").readFileSync(\"/w/out/manifest.json\", \"utf8\"));
const c = m.counts;
console.log(\"Backup de:     \" + m.created_at + \"  (versão \" + m.app_version + \", servidor \" + (m.public_host || \"?\") + \")\");
console.log(\"Migrations:    \" + m.migrations.length + \" (última: \" + (m.migrations.at(-1) || \"-\") + \")\");
console.log(\"Conteúdo:      \" + c.tenants + \" clientes, \" + c.users + \" usuários, \" + c.cameras + \" câmeras, \" + c.camera_events + \" eventos, \" + c.recording_segments + \" segmentos indexados\");
"' || die "resumo do backup ilegível"
if [ "$CHECK" = 1 ]; then log "arquivo íntegro (modo --check: nada foi alterado)"; exit 0; fi

echo
echo "ATENÇÃO: o banco atual será SUBSTITUÍDO pelo do backup e o .env pelo do backup."
[ -n "$LAB_HOST" ] && echo "Modo VM de teste: painel em http://$LAB_HOST e backup automático DESLIGADO."
if [ "$YES" != 1 ]; then
  read -r -p "Digite RESTAURAR para continuar: " ans
  [ "$ans" = RESTAURAR ] || die "cancelado; nada foi alterado"
fi

TS=$(date +%Y%m%d%H%M%S)
(umask 077 && cp .env ".env.antes-restauracao.$TS")
log "cópia do .env atual: .env.antes-restauracao.$TS"
install -m 600 "$WORK/out/topcam.env" .env
if [ -n "$LAB_HOST" ]; then
  setv PUBLIC_HOST "$LAB_HOST"
  setv SITE_ADDRESS ":80"
  setv HTTP_REDIRECT_ADDRESS "http://redirecionamento.invalid"
  setv PANEL_URL ""
  setv COOKIE_SECURE false
  setv RTMP_ENCRYPTION no
  setv WEBRTC_HOSTS "$LAB_HOST"
fi

log "parando os serviços"
dc stop api worker web gateway mediamtx backup >/dev/null 2>&1 || true
dc up -d --wait postgres redis >/dev/null
NEW_OWNER=$(getv POSTGRES_PASSWORD)
log "recriando o banco a partir do dump"
{
  printf "ALTER ROLE topcam_owner PASSWORD '%s';\n" "$NEW_OWNER"
  echo "DROP DATABASE IF EXISTS topcam WITH (FORCE);"
  echo "CREATE DATABASE topcam OWNER topcam_owner;"
  echo "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'topcam_app') THEN CREATE ROLE topcam_app NOLOGIN; END IF; END \$\$;"
} | dc exec -T postgres psql -U topcam_owner -d postgres -v ON_ERROR_STOP=1 -q -f - >/dev/null
docker cp "$WORK/out/topcam.dump" "$(dc ps -q postgres):/tmp/topcam.dump"
dc exec -T postgres pg_restore -U topcam_owner -d topcam --exit-on-error --no-password /tmp/topcam.dump ||
  die "pg_restore falhou; o .env anterior está em .env.antes-restauracao.$TS"
dc exec -T postgres rm -f /tmp/topcam.dump
# O dump é tirado durante a própria execução do backup: esse registro volta "em andamento".
# Marca-o como o backup restaurado (senão o serviço o registraria como interrompido).
ORIG_NAME=$(tool 'node -p "JSON.parse(require(\"fs\").readFileSync(\"/w/out/manifest.json\",\"utf8\")).file_name || \"\""' 2>/dev/null || true)
dc exec -T postgres psql -U topcam_owner -d topcam -q -v ON_ERROR_STOP=1 -v f="${ORIG_NAME:-$(basename "$FILE")}" <<'SQL' >/dev/null
UPDATE backup_runs SET status = 'success', finished_at = coalesce(started_at, created_at),
       file_name = coalesce(file_name, :'f'),
       message = 'Backup usado na restauração (registro copiado durante a própria execução)'
 WHERE status = 'running' AND kind = 'backup';
UPDATE backup_runs SET status = 'failed', finished_at = now(),
       error = 'Pedido pendente no momento do backup; descartado na restauração'
 WHERE status IN ('pending', 'running');
SQL

if [ -n "$LAB_HOST" ]; then
  log "VM de teste: desligando o backup automático (para não gravar no destino de produção)"
  dc exec -T postgres psql -U topcam_owner -d topcam -q -c \
    "UPDATE system_settings SET value = jsonb_set(value, '{enabled}', 'false') WHERE key = 'integrations.backup'" >/dev/null
fi

log "aplicando senhas e migrations"
dc up -d --wait postgres >/dev/null 2>&1
dc run --rm migrate >/dev/null
log "subindo os serviços"
dc up -d --wait >/dev/null 2>&1 || { dc ps; die "algum serviço não ficou saudável (veja docker compose logs)"; }
dc exec -T api node apps/api/dist/cli.js secrets:check
dc ps --format '{{.Service}}: {{.Status}}'
log "restauração concluída"
[ -n "$LAB_HOST" ] && echo "Painel: http://$LAB_HOST  (backup automático desligado; o firewall do host não foi instalado)"
echo "A cópia .env.antes-restauracao.$TS guarda o .env anterior; apague depois de conferir."
