#!/usr/bin/env bash
# TopCam — teste de disco do SISTEMA cheio (Fase 8). SÓ EM VM DE TESTE. Rode como root.
#
#   scripts/test-disk-full.sh --vm-de-teste
#
# Enche o disco do sistema (onde ficam banco, Docker, logs e, sem disco de vídeo, as
# gravações) com um arquivo temporário e depois apaga. Confere:
#   D1  a 90%: alerta "Disco do sistema" aberto
#   D2  a 100%: o que continua respondendo (informativo: é esperado degradar)
#   D3  liberado o espaço: tudo volta SOZINHO (serviços, banco gravando, gravação da
#       CAM-001 de teste), sem arquivo de vídeo fora do índice e banco íntegro (pg_amcheck)
#   D4  o alerta de disco fecha sozinho
# Travas: exige --vm-de-teste, recusa painel com domínio (produção) e pede confirmação.
# Relatório em reports/disco-cheio-<data>.md (gravado só depois de liberar o espaço).
set -uo pipefail
cd "$(dirname "$0")/.."

[ "${1:-}" = "--vm-de-teste" ] || { sed -n '2,15p' "$0"; exit 2; }
[ "$(id -u)" = 0 ] || { echo "rode como root" >&2; exit 2; }
[ -f .env ] || { echo "Arquivo .env não encontrado." >&2; exit 2; }
set -a; . ./.env; set +a
if [[ "${SITE_ADDRESS:-:80}" != :* ]]; then
  echo "RECUSADO: o painel está com domínio ($SITE_ADDRESS). Isto parece a produção." >&2
  exit 3
fi
[ -f /etc/topcam/host.conf ] && echo "Atenção: esta VM tem o serviço do host (firewall) instalado." >&2

# shellcheck disable=SC2086
dc() { docker compose ${COMPOSE_ARGS:-} "$@"; }
sql() { dc exec -T postgres psql -U topcam_owner -d topcam -Atq -c "$1" </dev/null 2>/dev/null | tr -d '\r'; }
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
now_s() { date +%s; }
wait_until() { local t="$1"; shift; local t0; t0=$(now_s); until "$@" >/dev/null 2>&1; do [ $(( $(now_s) - t0 )) -ge "$t" ] && return 1; sleep 5; done; }
pct() { df --output=pcent / | tail -1 | tr -dc '0-9'; }
FILL=/var/tmp/topcam-disco-cheio.img

echo "Este teste vai ENCHER o disco do sistema desta VM ($(df -h --output=size / | tail -1 | xargs)) e depois liberar."
read -r -p "Digite ENCHER para continuar: " ans
[ "$ans" = ENCHER ] || { echo "cancelado"; exit 1; }

RESULTS=(); FAILS=0
record() {
  RESULTS+=("| $1 | $3 | $([ "$2" = PASS ] && echo '✅ PASSOU' || { [ "$2" = INFO ] && echo 'ℹ️ INFORMATIVO' || echo '❌ FALHOU'; }) | $4 |")
  [ "$2" = FAIL ] && FAILS=$((FAILS + 1))
  log "$1 $2 — $4"
}
SERVICES=(postgres redis api worker backup web gateway mediamtx prometheus node-exporter)
healthy_all() {
  local s id st
  for s in "${SERVICES[@]}"; do
    id=$(dc ps -q "$s" 2>/dev/null); [ -n "$id" ] || return 1
    st=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}ok{{end}}' "$id")
    [[ "$st" == "running healthy" || "$st" == "running ok" ]] || return 1
  done
}
states() { docker ps --format '{{.Names}} {{.Status}}' | sed 's/topcam-//; s/-1 / /' | paste -sd';' -; }
fill_to() { # fill_to <pct>: aumenta o arquivo até o disco chegar na porcentagem
  local total avail want
  total=$(df --output=size -B1 / | tail -1); avail=$(df --output=avail -B1 / | tail -1)
  want=$(( avail - total * (100 - $1) / 100 ))
  [ "$want" -gt 0 ] || return 0
  local cur; cur=$(stat -c %s "$FILL" 2>/dev/null || echo 0)
  fallocate -l $(( cur + want )) "$FILL" 2>/dev/null || dd if=/dev/zero of="$FILL" bs=1M oflag=append conv=notrunc count=$(( want / 1048576 )) status=none 2>/dev/null
}

CAM1=$(sql "SELECT c.id FROM cameras c JOIN tenants t ON t.id = c.tenant_id WHERE t.slug = 'empresa-alfa' AND c.code = 'CAM-001' AND c.deleted_at IS NULL")
[ -n "$CAM1" ] || { echo "CAM-001 da Empresa Alfa não encontrada" >&2; exit 1; }
PREV_REC=$(sql "SELECT recording_enabled FROM cameras WHERE id = '$CAM1'")
KEY=$(dc exec -T api node apps/api/dist/cli.js camera:show-key --tenant empresa-alfa --code CAM-001 --raw </dev/null 2>/dev/null | tr -d '\r\n')
cleanup() {
  rm -f "$FILL"
  docker rm -f topcam-txdisco >/dev/null 2>&1
  sql "UPDATE cameras SET recording_enabled = '$PREV_REC'::boolean WHERE id = '$CAM1'" >/dev/null
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM HUP

healthy_all || { echo "Nem tudo está saudável antes do teste: $(states)" >&2; exit 1; }
P0=$(pct); T0=$(now_s); EV0=$(sql "SELECT coalesce(max(id), 0) FROM camera_events")
log "disco do sistema antes: ${P0}%"
sql "UPDATE cameras SET recording_enabled = true WHERE id = '$CAM1'" >/dev/null
sql "INSERT INTO durable_jobs (type, payload) VALUES ('mediamtx.reconcile', '{\"reason\":\"disco-cheio\"}')" >/dev/null
dc --profile test run -d --rm --name topcam-txdisco test-transmitter publish "$KEY" CAM-001 >/dev/null 2>&1
is_rec() { [ "$(sql "SELECT status FROM cameras WHERE id = '$CAM1'")" = gravando ]; }
wait_until 240 is_rec || log "aviso: a CAM-001 de teste não chegou a gravar antes do teste"

# ------------------------------------------------------------------ D1: 90%
log "D1: enchendo até 90%"
fill_to 90
alert_on() { [ "$(sql "SELECT count(*) FROM alerts WHERE rule = 'system_disk' AND status <> 'resolved'")" -ge 1 ]; }
wait_until 240 alert_on && ok=1 || ok=0
record D1 "$([ $ok = 1 ] && echo PASS || echo FAIL)" "Disco do sistema a 90%: alerta aberto" \
  "disco em $(pct)%; alerta: $(sql "SELECT severity || ' — ' || title FROM alerts WHERE rule = 'system_disk' AND status <> 'resolved' ORDER BY id DESC LIMIT 1")"

# ------------------------------------------------------------------ D2: 100%
log "D2: enchendo até o fim e segurando 3 minutos"
fill_to 100
dd if=/dev/zero of="$FILL.resto" bs=64k status=none 2>/dev/null   # completa o que sobrar
sleep 180
H=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:${HTTP_PORT:-80}/api/v1/health)
D2_STATES=$(states)
record D2 INFO "Disco a 100% por 3 min: o que continua respondendo (é esperado degradar)" \
  "disco em $(pct)%; API pelo gateway: HTTP $H; contêineres: $D2_STATES"

# ------------------------------------------------------------------ D3: liberar e voltar sozinho
log "D3: liberando o espaço e esperando tudo voltar sozinho (até 8 min)"
rm -f "$FILL" "$FILL.resto"
T_FREE=$(now_s)
wait_until 480 healthy_all && h_ok=1 || h_ok=0
T_BACK=$(( $(now_s) - T_FREE ))
db_write() { sql "CREATE TEMP TABLE t_disco (x int); INSERT INTO t_disco VALUES (1); SELECT 1" | grep -q 1; }
wait_until 120 db_write && w_ok=1 || w_ok=0
T_REC=$(sql "SELECT now()")
new_seg() { [ "$(sql "SELECT count(*) FROM recording_segments WHERE camera_id = '$CAM1' AND state = 'verified' AND started_at > '$T_REC'")" -ge 1 ]; }
wait_until 420 new_seg && r_ok=1 || r_ok=0
FILES=$(dc exec -T worker sh -c "cd /recordings && find cam/$CAM1 -type f -mmin -$(( ($(now_s) - T0) / 60 + 1 )) 2>/dev/null" </dev/null | tr -d '\r' | grep -E '\.(mp4|ts)$' || true)
ORPH=0
if [ -n "$FILES" ]; then
  LIST=$(sed "s/'/''/g; s/.*/('&')/" <<<"$FILES" | paste -sd, -)
  ORPH=$(sql "SELECT count(*) FROM (VALUES $LIST) f(p) WHERE NOT EXISTS (SELECT 1 FROM recording_segments s WHERE s.path = f.p)")
fi
AMCHECK=$(dc exec -T postgres pg_amcheck -U topcam_owner -d topcam </dev/null 2>&1 | tail -3 | tr '\n' ' '); am_rc=$?
[ -z "$AMCHECK" ] && AMCHECK="nenhum problema"
record D3 "$([ $h_ok = 1 ] && [ $w_ok = 1 ] && [ $r_ok = 1 ] && [ "${ORPH:-1}" = 0 ] && [ $am_rc = 0 ] && echo PASS || echo FAIL)" \
  "Espaço liberado: tudo volta sozinho, banco grava, gravação continua, índice e banco íntegros" \
  "serviços saudáveis em ${T_BACK} s: $([ $h_ok = 1 ] && echo sim || echo "NÃO ($(states))"); banco gravando: $([ $w_ok = 1 ] && echo sim || echo não); segmento novo conferido: $([ $r_ok = 1 ] && echo sim || echo não); arquivos do teste: $(grep -c . <<<"$FILES"), fora do índice: $ORPH; pg_amcheck: $AMCHECK"

# ------------------------------------------------------------------ D4: alerta fecha
alert_off() { [ "$(sql "SELECT count(*) FROM alerts WHERE rule = 'system_disk' AND status <> 'resolved'")" = 0 ]; }
wait_until 240 alert_off && ok=1 || ok=0
record D4 "$([ $ok = 1 ] && echo PASS || echo FAIL)" "Alerta de disco do sistema fecha sozinho" "disco em $(pct)%; alertas abertos de disco: $(sql "SELECT count(*) FROM alerts WHERE rule = 'system_disk' AND status <> 'resolved'")"

cleanup
mkdir -p reports
OUT="reports/disco-cheio-$(date +%Y%m%d-%H%M%S).md"
{
  echo "# Teste de disco do sistema cheio — $(date '+%d/%m/%Y %H:%M')"
  echo
  echo "Host: $(hostname) · disco antes: ${P0}% · commit: $(git rev-parse --short HEAD 2>/dev/null || echo '?')"
  echo
  echo "| # | Critério | Resultado | Evidência |"
  echo "|---|---|---|---|"
  printf '%s\n' "${RESULTS[@]}"
  echo
  echo "Eventos do período: $(sql "SELECT string_agg(type || '×' || n, ', ') FROM (SELECT type, count(*) n FROM camera_events WHERE id > $EV0 GROUP BY type ORDER BY n DESC) x")"
} >"$OUT"
echo; cat "$OUT"; echo; log "relatório: $OUT"
[ "$FAILS" -eq 0 ]
