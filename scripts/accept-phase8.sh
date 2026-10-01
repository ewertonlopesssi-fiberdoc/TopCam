#!/usr/bin/env bash
# TopCam — teste de aceite da Fase 8 (segurança, backup e resiliência). Rode como root.
#
#   H1  HTTPS: certificado válido (dias até vencer), http → https, HSTS, cookie seguro
#   H2  RTMPS na 1936 (se ligado)
#   F1  firewall do host: serviço ativo e regras aplicadas iguais às do painel
#   L1  chaves de câmera erradas: IP de teste bloqueado, com evento e alerta (limpo no fim)
#   S1  segredos: chaves legíveis, .env protegido, cópias antigas do .env
#   B1  backup: serviço ativo, último backup < 26 h; com --passphrase-file, o arquivo abre
#   R1  reinício de cada contêiner: tudo volta saudável, a gravação continua e o índice
#       não perde segmentos (CAM-001 de teste gravando com o transmissor de teste)
#   M1  lint e testes automatizados
#
# Reinício da VM (em horário tranquilo):
#   scripts/accept-phase8.sh --before-reboot     # guarda a foto do estado
#   reboot
#   scripts/accept-phase8.sh --after-reboot      # confere que tudo voltou sozinho
#
# Uso:  scripts/accept-phase8.sh [--skip-restart] [--skip-tests] [--passphrase-file ARQ]
#   nohup scripts/accept-phase8.sh > /root/aceite8.log 2>&1 &
# O R1 reinicia os contêineres um por um: câmeras reais que gravam têm lacunas de segundos.
# Relatório em reports/phase8-<data>.md.

set -uo pipefail
cd "$(dirname "$0")/.."

exec 9>/tmp/topcam-aceite.lock
if ! flock -n 9; then
  echo "Já existe um teste de aceite em execução nesta máquina. Aguarde terminar." >&2
  exit 3
fi

MODE=full SKIP_RESTART=0 RUN_TESTS=1 PASSFILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-restart) SKIP_RESTART=1; shift ;;
    --skip-tests) RUN_TESTS=0; shift ;;
    --passphrase-file) PASSFILE="$2"; shift 2 ;;
    --before-reboot) MODE=before; shift ;;
    --after-reboot) MODE=after; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "opção desconhecida: $1" >&2; exit 2 ;;
  esac
done

[ -f .env ] || { echo "Arquivo .env não encontrado." >&2; exit 2; }
set -a; . ./.env; set +a

# shellcheck disable=SC2086
dc() { docker compose ${COMPOSE_ARGS:-} "$@"; }
sql() { dc exec -T postgres psql -U topcam_owner -d topcam -Atq -c "$1" </dev/null 2>/dev/null | tr -d '\r'; }
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
now_s() { date +%s; }

mkdir -p reports
STAMP=$(date +%Y%m%d-%H%M%S)
STATE=reports/.aceite8-reboot.state
RESULTS=()
FAILS=0
SKIPS=0
TENANT=empresa-alfa

record() {
  RESULTS+=("| $1 | $3 | $([ "$2" = PASS ] && echo '✅ PASSOU' || echo '❌ FALHOU') | $4 |")
  [ "$2" = PASS ] || FAILS=$((FAILS + 1))
  log "$1 $2 — $4"
}
skip() {
  RESULTS+=("| $1 | $2 | ⏭️ PULADO | $3 |")
  SKIPS=$((SKIPS + 1))
  log "$1 PULADO — $3"
}
pass_if() { [ "$1" = 1 ] && echo PASS || echo FAIL; }
wait_until() {
  local timeout="$1"; shift
  local t0; t0=$(now_s)
  until "$@" >/dev/null 2>&1; do
    [ $(( $(now_s) - t0 )) -ge "$timeout" ] && return 1
    sleep 3
  done
}

cam_id() { sql "SELECT c.id FROM cameras c JOIN tenants t ON t.id = c.tenant_id WHERE t.slug = '$TENANT' AND c.code = '$1' AND c.deleted_at IS NULL"; }
status_of() { sql "SELECT status FROM cameras WHERE id = '$1'"; }
key_of() { dc exec -T api node apps/api/dist/cli.js camera:show-key --tenant "$TENANT" --code "$1" --raw </dev/null 2>/dev/null | tr -d '\r\n'; }
start_tx() { docker rm -f topcam-tx8-CAM-001 >/dev/null 2>&1; dc --profile test run -d --rm --name topcam-tx8-CAM-001 test-transmitter publish "$(key_of CAM-001)" CAM-001 >/dev/null 2>&1; }
stop_tx() { docker rm -f topcam-tx8-CAM-001 >/dev/null 2>&1; }
reconcile() { sql "INSERT INTO durable_jobs (type, payload) VALUES ('mediamtx.reconcile', '{\"reason\":\"aceite8\"}')" >/dev/null; dc exec -T redis redis-cli publish topcam:jobs:wake 1 >/dev/null 2>&1; }

# Serviços que devem estar sempre no ar (sem os de uma execução só e os de teste).
SERVICES=(postgres redis api worker motion backup web gateway mediamtx prometheus node-exporter)
healthy_all() {
  local s id st
  for s in "${SERVICES[@]}"; do
    id=$(dc ps -q "$s" 2>/dev/null)
    [ -n "$id" ] || return 1
    st=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}sem-healthcheck{{end}}' "$id")
    [[ "$st" == running\ healthy || "$st" == "running sem-healthcheck" ]] || return 1
  done
}
services_state() {
  local s id
  for s in "${SERVICES[@]}"; do
    id=$(dc ps -q "$s" 2>/dev/null)
    printf '%s=%s ' "$s" "$( [ -n "$id" ] && docker inspect -f '{{.State.Status}}{{if .State.Health}}/{{.State.Health.Status}}{{end}}' "$id" || echo ausente)"
  done
}

# Foto do índice: segmentos já concluídos e conferidos antes de T que não vencem nas próximas
# 2 h (o que ainda estava sendo gravado muda de estado ao terminar e fica de fora).
# Depois de reinícios, esse conjunto tem de continuar idêntico (mesmos ids, estado e tamanho).
index_snapshot() { # index_snapshot <T (timestamptz)>
  sql "SELECT count(*) || ' ' || coalesce(md5(string_agg(id::text || ':' || state || ':' || coalesce(size_bytes, 0), ',' ORDER BY id)), '-')
         FROM recording_segments
        WHERE ended_at < '$1' AND state = 'verified' AND expires_at > '$1'::timestamptz + interval '2 hours'"
}
# Arquivos da câmera no disco que não estão no índice (devem ser zero).
orphans_of() { # orphans_of <camera_id> <desde epoch s>
  local files
  # O índice guarda o caminho relativo à pasta de gravações (cam/<id>/<arquivo>).
  files=$(dc exec -T worker sh -c "cd /recordings && find cam/$1 -type f -mmin -$(( ($(now_s) - $2) / 60 + 1 )) 2>/dev/null" </dev/null | tr -d '\r' | grep -E '\.(mp4|ts)$' || true)
  [ -n "$files" ] || { echo "0 0"; return; }
  local list
  list=$(sed "s/'/''/g; s/.*/('&')/" <<<"$files" | paste -sd, -)
  echo "$(wc -l <<<"$files") $(sql "SELECT count(*) FROM (VALUES $list) f(p) WHERE NOT EXISTS (SELECT 1 FROM recording_segments s WHERE s.path = f.p)")"
}
recording_cams() { sql "SELECT coalesce(string_agg(id::text, ' ' ORDER BY id), '') FROM cameras WHERE status = 'gravando' AND deleted_at IS NULL"; }

write_report() { # write_report <arquivo> <título>
  {
    echo "# $2 — $(date '+%d/%m/%Y %H:%M')"
    echo
    echo "Host: $(hostname) · versão: ${TOPCAM_VERSION:-?} · commit: $(git rev-parse --short HEAD 2>/dev/null || echo '?')"
    echo
    echo "| # | Critério | Resultado | Evidência |"
    echo "|---|---|---|---|"
    printf '%s\n' "${RESULTS[@]}"
    echo
    echo "**Total: $(( ${#RESULTS[@]} - FAILS - SKIPS ))/$(( ${#RESULTS[@]} - SKIPS )) aprovados$([ "$SKIPS" -gt 0 ] && echo ", $SKIPS pulado(s)").**"
  } >"$1"
  echo; cat "$1"; echo
  log "relatório: $1"
}

# ================================================================== antes do reinício
if [ "$MODE" = before ]; then
  healthy_all || { echo "Nem todos os serviços estão saudáveis agora: $(services_state)" >&2; exit 1; }
  T=$(sql "SELECT now()")
  {
    echo "BOOT_ID=$(cat /proc/sys/kernel/random/boot_id)"
    echo "T='$T'"
    echo "SNAP='$(index_snapshot "$T")'"
    echo "RECORDING='$(recording_cams)'"
    echo "LAST_EVENT=$(sql "SELECT coalesce(max(id), 0) FROM camera_events")"
    echo "FIREWALL=$(nft list table inet topcam_fw >/dev/null 2>&1 && echo 1 || echo 0)"
  } >"$STATE"
  log "estado guardado em $STATE:"
  sed 's/^/    /' "$STATE"
  log "pode reiniciar a VM (reboot). Depois, rode: scripts/accept-phase8.sh --after-reboot"
  exit 0
fi

# ================================================================== depois do reinício
if [ "$MODE" = after ]; then
  [ -f "$STATE" ] || { echo "Rode antes: scripts/accept-phase8.sh --before-reboot" >&2; exit 2; }
  # shellcheck disable=SC1090
  . "$STATE"
  BOOT_NOW=$(cat /proc/sys/kernel/random/boot_id)
  BOOT_AT=$(date -d "@$(awk '/^btime/ {print $2}' /proc/stat)" '+%d/%m %H:%M:%S')
  record V1 "$(pass_if "$([ "$BOOT_NOW" != "$BOOT_ID" ] && echo 1)")" "A VM foi reiniciada" \
    "ligada às $BOOT_AT (identificador de boot $([ "$BOOT_NOW" != "$BOOT_ID" ] && echo mudou || echo 'NÃO mudou: não houve reinício'))"

  log "V2: aguardando os serviços subirem sozinhos (até 5 min)"
  T0=$(now_s)
  if wait_until 300 healthy_all; then ok=1; else ok=0; fi
  record V2 "$(pass_if $ok)" "Todos os serviços voltaram sozinhos e saudáveis" \
    "$(services_state)(em $(( $(now_s) - T0 )) s após este comando)"

  fw_ok=0; tm=""
  if [ "$FIREWALL" = 1 ]; then
    tm=$(systemctl is-active topcam-host.timer 2>/dev/null)
    nft list table inet topcam_fw >/dev/null 2>&1 && [ "$tm" = active ] && fw_ok=1
    record V3 "$(pass_if $fw_ok)" "Firewall do host restaurado e serviço ativo" "tabela topcam_fw: $([ $fw_ok = 1 ] && echo presente || echo ausente); timer: ${tm:-?}"
  else
    skip V3 "Firewall do host restaurado e serviço ativo" "firewall não estava aplicado antes do reinício"
  fi

  PUB_IP=$(getent ahostsv4 "${PUBLIC_HOST:-}" 2>/dev/null | awk 'NR==1{print $1}')
  if [ -n "$PUB_IP" ] && ! [[ "$PUB_IP" =~ ^127\. ]]; then
    ip -4 addr show 2>/dev/null | grep -qw "inet $PUB_IP" && ok=1 || ok=0
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "${PUBLIC_HOST}:443:127.0.0.1" "https://${PUBLIC_HOST}/api/v1/health")
    [ "$code" = 200 ] || { [[ "${SITE_ADDRESS:-:80}" == :* ]] && code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1/api/v1/health); }
    record V4 "$(pass_if "$([ $ok = 1 ] && [ "$code" = 200 ] && echo 1)")" "Endereço público no servidor e painel respondendo" \
      "$PUBLIC_HOST → $PUB_IP ($([ $ok = 1 ] && echo 'IP presente na VM' || echo 'IP AUSENTE na VM')); painel: HTTP $code"
  else
    skip V4 "Endereço público no servidor e painel respondendo" "PUBLIC_HOST sem IP público resolvível"
  fi

  if [ -n "$RECORDING" ]; then
    log "V5: aguardando as câmeras que gravavam voltarem a gravar (até 6 min)"
    back_all() { local c; for c in $RECORDING; do [ "$(status_of "$c")" = gravando ] || return 1; done; }
    new_seg_all() { local c; for c in $RECORDING; do [ "$(sql "SELECT count(*) FROM recording_segments WHERE camera_id = '$c' AND state = 'verified' AND started_at > now() - interval '15 minutes' AND started_at > (SELECT to_timestamp($(awk '/^btime/ {print $2}' /proc/stat)))")" -ge 1 ] || return 1; done; }
    wait_until 360 back_all && wait_until 300 new_seg_all && ok=1 || ok=0
    names=$(sql "SELECT string_agg(t.slug || '/' || c.code || '=' || c.status, ', ') FROM cameras c JOIN tenants t ON t.id = c.tenant_id WHERE c.id::text IN ($(sed "s/[^ ]*/'&'/g; s/ /,/g" <<<"$RECORDING"))")
    record V5 "$(pass_if $ok)" "Câmeras que gravavam voltaram a gravar (segmento novo conferido)" "$names"
  else
    skip V5 "Câmeras que gravavam voltaram a gravar" "nenhuma câmera gravava antes do reinício"
  fi

  SNAP_NOW=$(index_snapshot "$T")
  MISSING=$(sql "SELECT count(*) FROM camera_events WHERE id > $LAST_EVENT AND type IN ('segment_missing', 'segment_corrupt')")
  record V6 "$(pass_if "$([ "$SNAP_NOW" = "$SNAP" ] && [ "${MISSING:-1}" = 0 ] && echo 1)")" \
    "Índice das gravações sem perda (segmentos anteriores ao reinício intactos)" \
    "antes: ${SNAP%% *} segmento(s); depois: ${SNAP_NOW%% *} ($([ "$SNAP_NOW" = "$SNAP" ] && echo idênticos || echo DIFERENTES)); segmentos faltando/corrompidos desde então: ${MISSING:-?}"

  write_report "reports/phase8-reboot-${STAMP}.md" "Aceite da Fase 8 — reinício da VM"
  rm -f "$STATE"
  [ "$FAILS" -eq 0 ]
  exit
fi

# ================================================================== aceite completo
dc up -d --wait >/dev/null 2>&1 || { dc ps; echo "falha ao subir o ambiente" >&2; exit 1; }

# ------------------------------------------------------------------ H1: HTTPS
SITE="${SITE_ADDRESS:-:80}"
if [[ "$SITE" == :* || -z "$SITE" ]]; then
  skip H1 "HTTPS com certificado válido, redirecionamento, HSTS e cookie seguro" "painel em HTTP (SITE_ADDRESS=$SITE); ligar com scripts/https.sh"
else
  log "H1: HTTPS de $SITE"
  CERT=$(echo | timeout 10 openssl s_client -connect 127.0.0.1:${HTTPS_PORT:-443} -servername "$SITE" 2>/dev/null | openssl x509 -noout -issuer -enddate 2>/dev/null)
  END=$(sed -n 's/^notAfter=//p' <<<"$CERT")
  DAYS=$(( ( $(date -d "$END" +%s 2>/dev/null || echo 0) - $(now_s) ) / 86400 ))
  ISSUER=$(sed -n 's/^issuer=.*O *= *\([^,]*\).*/\1/p' <<<"$CERT")
  VERIFY=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$SITE:${HTTPS_PORT:-443}:127.0.0.1" "https://$SITE/api/v1/health")
  REDIR=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 10 http://127.0.0.1/login)
  HSTS=$(curl -sI --max-time 10 --resolve "$SITE:${HTTPS_PORT:-443}:127.0.0.1" "https://$SITE/login" | grep -ci '^strict-transport-security')
  ok=$([ "$VERIFY" = 200 ] && [ "$DAYS" -ge 14 ] && [[ "$REDIR" == 30[178]\ https://$SITE/* ]] && [ "$HSTS" -ge 1 ] && [ "${COOKIE_SECURE:-false}" = true ] && echo 1)
  record H1 "$(pass_if "$ok")" "HTTPS com certificado válido, redirecionamento, HSTS e cookie seguro" \
    "certificado ${ISSUER:-?}, vence em $DAYS dia(s) (renovação automática aos 30); https conferido: HTTP $VERIFY; http://IP → $REDIR; HSTS: $([ "$HSTS" -ge 1 ] && echo sim || echo não); cookie seguro: ${COOKIE_SECURE:-false}"
fi

# ------------------------------------------------------------------ H2: RTMPS
if [ "${RTMP_ENCRYPTION:-no}" = no ]; then
  skip H2 "RTMPS na porta 1936" "desligado (RTMP_ENCRYPTION=no); ligar com scripts/https.sh --rtmps on"
else
  HS=$(echo | timeout 10 openssl s_client -connect 127.0.0.1:${RTMPS_PUBLIC_PORT:-1936} -servername "${PUBLIC_HOST:-localhost}" 2>/dev/null | grep -E "^(New|Protocol)" | head -1)
  record H2 "$(pass_if "$([ -n "$HS" ] && echo 1)")" "RTMPS na porta 1936" "${HS:-sem handshake TLS}"
fi

# ------------------------------------------------------------------ F1: firewall
log "F1: firewall do host"
if ! command -v nft >/dev/null 2>&1 || [ ! -f /etc/topcam/host.conf ]; then
  record F1 FAIL "Firewall do host ativo e igual ao painel" "serviço do host não instalado (scripts/host/topcam-host install)"
else
  TM=$(systemctl is-active topcam-host.timer 2>/dev/null)
  TABLE=$(nft list table inet topcam_fw 2>/dev/null)
  PANEL=$(sql "SELECT string_agg(cidr::text, ' ' ORDER BY cidr) FROM firewall_ssh_networks")
  STJSON=$(sql "SELECT value FROM system_settings WHERE key = 'firewall.status'")
  APPLIED=$(sql "SELECT string_agg(x, ' ' ORDER BY x::cidr) FROM jsonb_array_elements_text((SELECT value->'networks' FROM system_settings WHERE key = 'firewall.status')) x")
  AGE=$(sql "SELECT round(extract(epoch FROM now() - (value->>'checked_at')::timestamptz)) FROM system_settings WHERE key = 'firewall.status'")
  ok=$([ "$TM" = active ] && [ -n "$TABLE" ] && [ "$PANEL" = "$APPLIED" ] && [[ "$STJSON" == *'"ok": true'* ]] && [ "${AGE:-9999}" -lt 300 ] && echo 1)
  record F1 "$(pass_if "$ok")" "Firewall do host ativo e igual ao painel" \
    "timer: ${TM:-?}; tabela: $([ -n "$TABLE" ] && echo presente || echo ausente); painel: ${PANEL:-nenhuma}; aplicado: ${APPLIED:-nenhuma}; conferido há ${AGE:-?} s"
fi

# ------------------------------------------------------------------ L1: chaves erradas
log "L1: IP de teste errando chaves de câmera"
TIP="198.18.$(( RANDOM % 250 + 1 )).$(( RANDOM % 250 + 1 ))"
MAXK=${PUBLISH_BADKEY_MAX:-20}
EV0=$(sql "SELECT coalesce(max(id), 0) FROM camera_events")
dc exec -T -e TIP="$TIP" -e N="$((MAXK + 3))" api node --input-type=module -e '
  const s = process.env.MEDIA_HOOK_SECRET;
  for (let i = 0; i < Number(process.env.N); i++) {
    const key = Array.from({ length: 40 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"[Math.floor(Math.random() * 54)]).join("");
    await fetch(`http://127.0.0.1:3000/internal/mediamtx/auth?secret=${s}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: "", password: "", ip: process.env.TIP, action: "publish", path: `live/${key}`, protocol: "rtmp", id: null, query: "" }),
    });
  }' </dev/null >/dev/null 2>&1
BLOCKED=$(sql "SELECT count(*) FROM camera_events WHERE id > $EV0 AND type = 'publish_ip_blocked' AND host(source_ip) = '$TIP'")
REJ=$(sql "SELECT count(*) FROM camera_events WHERE id > $EV0 AND type = 'auth_rejected' AND host(source_ip) = '$TIP'")
ALERT=$(sql "SELECT status FROM alerts WHERE dedup_key = 'security.publish_ip_blocked:$TIP' ORDER BY id DESC LIMIT 1")
record L1 "$(pass_if "$([ "$BLOCKED" = 1 ] && [ "$ALERT" = open ] && [ "${REJ:-99}" -le "$MAXK" ] && echo 1)")" \
  "Chaves de câmera erradas: IP bloqueado, com evento e alerta; tentativas seguintes sem registro" \
  "IP de teste $TIP: $((MAXK + 3)) tentativas; bloqueado: $([ "$BLOCKED" = 1 ] && echo sim || echo não); recusas registradas: $REJ (limite $MAXK); alerta: ${ALERT:-nenhum}"
sql "UPDATE alerts SET status = 'resolved', resolved_at = now(), updated_at = now() WHERE dedup_key = 'security.publish_ip_blocked:$TIP' AND status <> 'resolved'" >/dev/null
dc exec -T redis sh -c "redis-cli --scan --pattern 'topcam:rl:badkey*$TIP' | xargs -r redis-cli del" </dev/null >/dev/null 2>&1

# ------------------------------------------------------------------ S1: segredos
log "S1: segredos"
CHECK=$(dc exec -T api node apps/api/dist/cli.js secrets:check </dev/null 2>&1 | tr -d '\r' | tail -1); rc=$?
PERM=$(stat -c %a .env)
OLDENV=$(ls -1 .env.* 2>/dev/null | grep -v '^.env.example$' | tr '\n' ' ')
record S1 "$(pass_if "$([[ "$CHECK" == *"ilegíveis: 0"* ]] && [[ "$CHECK" != *ILEGÍVEL* ]] && [ "$PERM" = 600 ] && echo 1)")" \
  "Segredos: chaves cifradas legíveis e .env só para o root" \
  "$CHECK; .env: $PERM; cópias antigas do .env: ${OLDENV:-nenhuma}$([ -n "$OLDENV" ] && echo ' (apagar depois de conferir)')"

# ------------------------------------------------------------------ B1: backup
log "B1: backup"
BEAT=$(sql "SELECT round(extract(epoch FROM now() - (value->>'at')::timestamptz)) FROM system_settings WHERE key = 'backup.heartbeat'")
BSET=$(sql "SELECT coalesce(value->>'enabled', 'false') || ' ' || coalesce(value->>'local_only', 'false') FROM system_settings WHERE key = 'integrations.backup'")
LAST=$(sql "SELECT round(extract(epoch FROM now() - max(finished_at)) / 3600, 1) FROM backup_runs WHERE kind = 'backup' AND status = 'success'")
NEWEST=$(ls -1t .data/backups/topcam-*.tar.gpg 2>/dev/null | head -1)
OPEN="não conferido (use --passphrase-file)"
open_ok=1
if [ -n "$PASSFILE" ]; then
  if [ -n "$NEWEST" ] && scripts/restore.sh --file "$NEWEST" --passphrase-file "$PASSFILE" --check >/dev/null 2>&1; then
    OPEN="abre com a senha: sim"
  else
    OPEN="abre com a senha: NÃO"; open_ok=0
  fi
fi
record B1 "$(pass_if "$([ "${BEAT:-9999}" -lt 120 ] && [ "${BSET%% *}" = true ] && [ -n "$LAST" ] && awk "BEGIN{exit !($LAST < 26)}" && [ $open_ok = 1 ] && echo 1)")" \
  "Backup: serviço ativo, automático ligado, último concluído há menos de 26 h" \
  "sinal de vida há ${BEAT:-?} s; automático: ${BSET%% *}$([ "${BSET#* }" = true ] && echo ' (somente no servidor)'); último concluído há ${LAST:-nunca} h; cópia local mais recente: $(basename "${NEWEST:-nenhuma}"); $OPEN"

# ------------------------------------------------------------------ R1: reinício dos contêineres
if [ "$SKIP_RESTART" = 1 ]; then
  skip R1 "Reinício de cada contêiner: tudo volta, gravação continua, índice sem perda" "--skip-restart"
elif [ "$(sql "SELECT value FROM system_settings WHERE key = 'recording.globally_enabled'")" != true ]; then
  skip R1 "Reinício de cada contêiner: tudo volta, gravação continua, índice sem perda" "gravação geral desligada no painel"
else
  CAM1=$(cam_id CAM-001)
  [ -n "$CAM1" ] || { echo "CAM-001 da Empresa Alfa não encontrada (seed de demonstração)" >&2; exit 1; }
  PREV_REC=$(sql "SELECT recording_enabled FROM cameras WHERE id = '$CAM1'")
  CLEANED=0
  cleanup() {
    [ "$CLEANED" = 1 ] && return
    CLEANED=1
    log "limpeza: transmissor parado, CAM-001 de teste volta ao estado anterior, gravações de teste apagadas"
    stop_tx
    sql "UPDATE cameras SET recording_enabled = '$PREV_REC'::boolean WHERE id = '$CAM1'" >/dev/null
    [ "$PREV_REC" = t ] || sql "UPDATE recording_segments SET expires_at = now() - interval '1 second' WHERE camera_id = '$CAM1' AND started_at >= '$T_R1' AND state NOT IN ('deleting', 'deleted')" >/dev/null
    reconcile
  }
  trap cleanup EXIT
  trap 'cleanup; exit 130' INT TERM
  trap 'cleanup; exit 129' HUP

  T_R1=$(sql "SELECT now()")
  REAL=$(sql "SELECT coalesce(string_agg(id::text, ' ' ORDER BY id), '') FROM cameras WHERE status = 'gravando' AND deleted_at IS NULL AND id <> '$CAM1'")
  log "R1: ligando a gravação da CAM-001 de teste com o transmissor de teste"
  sql "UPDATE cameras SET recording_enabled = true WHERE id = '$CAM1'" >/dev/null
  reconcile
  start_tx
  is_rec() { [ "$(status_of "$CAM1")" = gravando ]; }
  wait_until 240 is_rec || log "aviso: a CAM-001 de teste não chegou a \"gravando\" em 4 min"
  sleep 20
  T_SNAP=$(sql "SELECT now()")
  SNAP=$(index_snapshot "$T_SNAP")
  EPOCH0=$(now_s)
  TIMES=""
  for s in redis postgres api worker motion backup web gateway mediamtx; do
    log "R1: reiniciando $s"
    t=$(now_s)
    dc restart "$s" >/dev/null 2>&1
    wait_until 300 healthy_all || log "aviso: nem tudo saudável após reiniciar $s: $(services_state)"
    TIMES="$TIMES$s $(( $(now_s) - t ))s, "
    sleep 5
  done
  T_LAST=$(sql "SELECT now()")
  healthy_all && all_ok=1 || all_ok=0

  log "R1: aguardando segmento novo e o índice acompanhar (até 5 min)"
  new_seg() { [ "$(sql "SELECT count(*) FROM recording_segments WHERE camera_id = '$CAM1' AND state = 'verified' AND started_at > '$T_LAST'")" -ge 1 ]; }
  wait_until 300 new_seg && seg_ok=1 || seg_ok=0
  settled() { [ "$(sql "SELECT count(*) FROM recording_segments WHERE camera_id = '$CAM1' AND state = 'writing' AND started_at < '$T_LAST'")" = 0 ]; }
  wait_until 240 settled
  no_orphans() { [ "$(orphans_of "$CAM1" "$EPOCH0" | awk '{print $2}')" = 0 ]; }
  wait_until 180 no_orphans
  read -r NFILES NORPH <<<"$(orphans_of "$CAM1" "$EPOCH0")"
  SNAP2=$(index_snapshot "$T_SNAP")
  real_ok=1; REAL_TXT=""
  if [ -n "$REAL" ]; then
    back() { local c; for c in $REAL; do [ "$(status_of "$c")" = gravando ] || return 1; done; }
    wait_until 240 back || real_ok=0
    REAL_TXT="; câmeras reais que gravavam: $(sql "SELECT string_agg(c.code || '=' || c.status, ', ') FROM cameras c WHERE c.id::text IN ($(sed "s/[^ ]*/'&'/g; s/ /,/g" <<<"$REAL"))")"
  fi
  record R1 "$(pass_if "$([ $all_ok = 1 ] && [ $seg_ok = 1 ] && [ "$SNAP2" = "$SNAP" ] && [ "${NORPH:-1}" = 0 ] && [ $real_ok = 1 ] && echo 1)")" \
    "Reinício de cada contêiner: tudo volta, gravação continua, índice sem perda" \
    "tempos até ficar saudável: ${TIMES%, }; segmento novo conferido: $([ $seg_ok = 1 ] && echo sim || echo não); índice anterior: ${SNAP%% *} segmento(s) $([ "$SNAP2" = "$SNAP" ] && echo idênticos || echo DIFERENTES); arquivos gravados no teste: $NFILES, fora do índice: ${NORPH:-?}$REAL_TXT"
  cleanup
fi

# ------------------------------------------------------------------ M1: testes
TEST_LOG="reports/phase8-${STAMP}-testes.log"
if [ "$RUN_TESTS" = 1 ]; then
  log "M1: lint + testes"
  dc --profile test build tests >/dev/null 2>&1 || log "aviso: falha ao construir a imagem de testes"
  dc --profile test run --rm -e NO_COLOR=1 tests sh -c "pnpm lint && pnpm test" >"$TEST_LOG" 2>&1; rc=$?
  summary=$(sed 's/\x1b\[[0-9;]*m//g' "$TEST_LOG" | grep -E "^\s+Tests\s" | tail -n1 | xargs)
  record M1 "$([ $rc -eq 0 ] && echo PASS || echo FAIL)" "Lint e testes automatizados" "${summary:-sem resumo} (log: $TEST_LOG)"
else
  skip M1 "Lint e testes automatizados" "--skip-tests"
fi

write_report "reports/phase8-${STAMP}.md" "Aceite da Fase 8"
[ "$FAILS" -eq 0 ]
