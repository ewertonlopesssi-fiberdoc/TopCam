#!/usr/bin/env bash
# TopCam — aceite da detecção de movimento, gravação só com movimento e alarme. Rode como root.
#
#   V1  serviço "motion" saudável; porta de eventos (2525) aceita conexão pelo IP público
#   V2  e-mail da câmera (com STARTTLS e sem criptografia) → movimento registrado; avisos
#       seguidos viram um só movimento
#   V3  senha de eventos errada é recusada (e não registra movimento)
#   V4  detector do servidor: vídeo com movimento gera aviso; imagem parada não gera
#   V5  gravação só com movimento: segmentos nascem em espera (1 h) e os que têm movimento
#       passam a valer a retenção normal
#   V6  alarme: cada movimento novo recebe a decisão do alarme (sem enviar e-mail no teste)
#   V7  firewall do host libera a porta 2525 (se o serviço do host estiver instalado)
#   M1  lint e testes automatizados
#
# Usa só câmeras do cliente de teste "Empresa Alfa" (CAM-002 e CAM-003) com o transmissor
# de teste; tudo volta como estava no fim. Câmeras reais não são tocadas.
#
# Uso:  scripts/accept-motion.sh [--skip-tests]
#   nohup scripts/accept-motion.sh > /root/aceite-movimento.log 2>&1 &
# Relatório em reports/movimento-<data>.md.

set -uo pipefail
cd "$(dirname "$0")/.."

exec 9>/tmp/topcam-aceite.lock
if ! flock -n 9; then
  echo "Já existe um teste de aceite em execução nesta máquina. Aguarde terminar." >&2
  exit 3
fi

RUN_TESTS=1
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-tests) RUN_TESTS=0; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
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
wait_until() {
  local timeout="$1"; shift
  local t0; t0=$(now_s)
  until "$@" >/dev/null 2>&1; do
    [ $(( $(now_s) - t0 )) -ge "$timeout" ] && return 1
    sleep 3
  done
}

mkdir -p reports
STAMP=$(date +%Y%m%d-%H%M%S)
RESULTS=()
FAILS=0
SKIPS=0
TENANT=empresa-alfa
PORT=${EVENTS_SMTP_PUBLIC_PORT:-2525}

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
ok_if() { [ "$1" = 1 ] && echo PASS || echo FAIL; }

cam_id() { sql "SELECT c.id FROM cameras c JOIN tenants t ON t.id = c.tenant_id WHERE t.slug = '$TENANT' AND c.code = '$1' AND c.deleted_at IS NULL"; }
key_of() { dc exec -T api node apps/api/dist/cli.js camera:show-key --tenant "$TENANT" --code "$1" --raw </dev/null 2>/dev/null | tr -d '\r\n'; }
start_tx() { # start_tx <code> [still]
  docker rm -f "topcam-txmov-$1" >/dev/null 2>&1
  dc --profile test run -d --rm --name "topcam-txmov-$1" -e TX_STILL="${2:-0}" test-transmitter publish "$(key_of "$1")" "$1" >/dev/null 2>&1
}
stop_tx() { docker rm -f "topcam-txmov-$1" >/dev/null 2>&1; }
reconcile() { sql "INSERT INTO durable_jobs (type, payload) VALUES ('mediamtx.reconcile', '{\"reason\":\"aceite-movimento\"}')" >/dev/null; dc exec -T redis redis-cli publish topcam:jobs:wake 1 >/dev/null 2>&1; }

# Node dentro do contêiner da API (tem @topcam/shared e o cliente de e-mail).
# A "câmera" de teste aceita o certificado do receptor sem conferir (nome interno "motion").
node_api() { dc exec -T -e NODE_TLS_REJECT_UNAUTHORIZED=0 -e NODE_NO_WARNINGS=1 -w /app/apps/api api node --input-type=module -e "$1" </dev/null 2>&1 | tr -d '\r'; }

CAM2=$(cam_id CAM-002)
CAM3=$(cam_id CAM-003)
[ -n "$CAM2" ] && [ -n "$CAM3" ] || { echo "CAM-002/CAM-003 da Empresa Alfa não encontradas (seed de demonstração)" >&2; exit 1; }

# Estado anterior (para devolver no fim).
COLS="recording_enabled, recording_mode, motion_source, motion_sensitivity, alarm_enabled, alarm_schedule::text, alarm_cooldown_s, alarm_email, motion_smtp_user, motion_smtp_hash, retention_policy_id"
PREV2=$(sql "SELECT row_to_json(x) FROM (SELECT $COLS FROM cameras WHERE id = '$CAM2') x")
PREV3=$(sql "SELECT row_to_json(x) FROM (SELECT $COLS FROM cameras WHERE id = '$CAM3') x")
T0=$(sql "SELECT now()")
restore_cam() { # restore_cam <id> <json>
  local j="${2//\'/\'\'}"
  sql "UPDATE cameras c SET recording_enabled = p.recording_enabled, recording_mode = p.recording_mode,
         motion_source = p.motion_source, motion_sensitivity = p.motion_sensitivity,
         alarm_enabled = p.alarm_enabled, alarm_schedule = p.alarm_schedule::jsonb,
         alarm_cooldown_s = p.alarm_cooldown_s, alarm_email = p.alarm_email,
         motion_smtp_user = p.motion_smtp_user, motion_smtp_hash = p.motion_smtp_hash,
         retention_policy_id = p.retention_policy_id
       FROM json_to_record('$j'::json) AS p(recording_enabled boolean, recording_mode text, motion_source text,
         motion_sensitivity smallint, alarm_enabled boolean, alarm_schedule text, alarm_cooldown_s int,
         alarm_email boolean, motion_smtp_user text, motion_smtp_hash text, retention_policy_id uuid)
      WHERE c.id = '$1'" >/dev/null
}
cleanup() {
  stop_tx CAM-002
  [ -n "$PREV2" ] && restore_cam "$CAM2" "$PREV2"
  [ -n "$PREV3" ] && restore_cam "$CAM3" "$PREV3"
  # O que ficou em espera durante o teste: apaga já (câmera de teste) se ela não gravava antes;
  # se gravava, volta a valer a retenção normal.
  if [[ "$PREV2" == *'"recording_enabled":true'* ]]; then
    sql "UPDATE recording_segments s SET motion_hold = false, expires_at = s.started_at + make_interval(hours => coalesce(rp.retention_hours, 24))
           FROM cameras c LEFT JOIN retention_policies rp ON rp.id = c.retention_policy_id
          WHERE c.id = s.camera_id AND s.camera_id = '$CAM2' AND s.started_at >= '$T0'" >/dev/null
  else
    sql "UPDATE recording_segments SET expires_at = now() - interval '1 second'
          WHERE camera_id = '$CAM2' AND started_at >= '$T0' AND state NOT IN ('deleting', 'deleted')" >/dev/null
  fi
  reconcile
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM HUP

# ------------------------------------------------------------------ V1: serviço e porta
id=$(dc ps -q motion 2>/dev/null)
st=$( [ -n "$id" ] && docker inspect -f '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id" || echo ausente)
PUBIP=${PUBLIC_HOST:-127.0.0.1}
greeting() { timeout 6 bash -c "exec 3<>/dev/tcp/$1/$PORT && IFS= read -r -t 5 l <&3 && echo \"\$l\"" 2>/dev/null | tr -d '\r' | head -c 80; }
banner=$(greeting "$PUBIP")
[ -z "$banner" ] && banner=$(greeting 127.0.0.1)
record V1 "$(ok_if "$([ "$st" = running/healthy ] && [[ "$banner" == 220* ]] && echo 1)")" \
  "Serviço de movimento no ar e porta de eventos aberta" "contêiner: $st; resposta na porta $PORT ($PUBIP): ${banner:-nenhuma}"

# ------------------------------------------------------------------ V2/V3: e-mail da câmera
log "V2: gerando credencial de eventos de teste para a CAM-003"
CRED=$(node_api "import { generateSmtpCredential, hashSmtpPassword } from '@topcam/shared';
const c = generateSmtpCredential(); console.log(c.user + ' ' + c.password + ' ' + hashSmtpPassword(c.user, c.password));")
read -r SUSER SPASS SHASH <<<"$CRED"
sql "UPDATE cameras SET motion_source = 'camera', motion_smtp_user = '$SUSER', motion_smtp_hash = '$SHASH', alarm_enabled = false WHERE id = '$CAM3'" >/dev/null
send_mail() { # send_mail <security none|starttls> <senha> <assunto> → "ok" ou o erro
  node_api "import { sendMail, encryptSecret } from '@topcam/shared';
import { randomBytes } from 'node:crypto';
const k = randomBytes(32);
try {
  await sendMail({ enabled: true, host: 'motion', port: 2525, security: '$1', username: '$SUSER',
    password_enc: encryptSecret('$2', k), from_name: 'Camera', from_email: 'camera@teste.local',
    recipients: [], min_severity: 'error', notify_resolved: false }, k,
    { to: ['eventos@topcam.local'], subject: '$3', text: 'Alarm Event' }, { timeoutMs: 10000 });
  console.log('ok');
} catch (e) { console.log('erro: ' + e.message); }"
}
R_TLS=$(send_mail starttls "$SPASS" "Motion Detection" | tail -1)
R_PLAIN=$(send_mail none "$SPASS" "SMD Human Detection" | tail -1)
EV=$(sql "SELECT count(*) || ' evento(s); avisos=' || coalesce(sum(hits), 0) || '; tipo=' || coalesce(string_agg(kind, ','), '-') FROM motion_events WHERE camera_id = '$CAM3' AND created_at >= '$T0'")
record V2 "$(ok_if "$([ "$R_PLAIN" = ok ] && [[ "$EV" == "1 evento(s); avisos=2;"* ]] && echo 1)")" \
  "E-mail da câmera vira movimento (avisos seguidos = um movimento)" \
  "com STARTTLS: $R_TLS; sem criptografia: $R_PLAIN; registrado: $EV"
if [ "$R_TLS" != ok ]; then
  RESULTS[-1]="${RESULTS[-1]% |} (STARTTLS não passou: conferir o certificado em .data/tls) |"
fi

R_BAD=$(send_mail none "senha-errada-123" "Motion" | tail -1)
EV2=$(sql "SELECT coalesce(sum(hits), 0) FROM motion_events WHERE camera_id = '$CAM3' AND created_at >= '$T0'")
record V3 "$(ok_if "$([[ "$R_BAD" == erro:* ]] && [ "$EV2" = 2 ] && echo 1)")" \
  "Senha de eventos errada é recusada" "resposta: ${R_BAD:0:120}; avisos registrados continuam: $EV2"

# ------------------------------------------------------------------ V4/V5/V6: detector, gravação, alarme
GLOBAL=$(sql "SELECT coalesce(value::text, 'false') FROM system_settings WHERE key = 'recording.globally_enabled'")
SEVEN=$(sql "SELECT id FROM retention_policies WHERE tenant_id IS NULL ORDER BY retention_hours LIMIT 1")
sql "UPDATE cameras SET motion_source = 'server', motion_sensitivity = 5, recording_enabled = true, recording_mode = 'motion',
       retention_policy_id = coalesce(retention_policy_id, '$SEVEN'), alarm_enabled = true, alarm_email = false,
       alarm_schedule = '{\"rules\": []}', alarm_cooldown_s = 60 WHERE id = '$CAM2'" >/dev/null
reconcile
log "V4: transmissor de teste com movimento na CAM-002 (até 3 min)"
start_tx CAM-002 0
T_MOV=$(sql "SELECT now()")
has_server_motion() { [ "$(sql "SELECT count(*) FROM motion_events WHERE camera_id = '$CAM2' AND source = 'server' AND created_at >= '$T_MOV'")" -ge 1 ]; }
wait_until 180 has_server_motion && mov=1 || mov=0

log "V5: aguardando um segmento conferido mantido por movimento (até 4 min)"
kept() { [ "$(sql "SELECT count(*) FROM recording_segments WHERE camera_id = '$CAM2' AND started_at >= '$T_MOV' AND state = 'verified' AND NOT motion_hold")" -ge 1 ]; }
wait_until 240 kept && k_ok=1 || k_ok=0

DET=$(sql "SELECT count(*) || ' movimento(s), ' || coalesce(sum(hits), 0) || ' aviso(s)' FROM motion_events WHERE camera_id = '$CAM2' AND created_at >= '$T_MOV'")
log "V4: imagem parada (sem movimento) por 2 min"
start_tx CAM-002 1
sleep 75 # o primeiro quadro parado ainda difere do último em movimento; e a junção dura 60 s
T_STILL=$(sql "SELECT now()")
sleep 60
STILL=$(sql "SELECT coalesce(sum(hits), 0) FROM motion_events WHERE camera_id = '$CAM2' AND source = 'server' AND (started_at >= '$T_STILL' OR ended_at > '$T_STILL'::timestamptz + interval '15 seconds')")
record V4 "$(ok_if "$([ $mov = 1 ] && [ "$STILL" = 0 ] && echo 1)")" \
  "Detector do servidor: movimento gera aviso; imagem parada não" \
  "com movimento: $DET; avisos com a imagem parada: $STILL; reinícios do detector (inclui as trocas do transmissor): $(dc logs --since 10m motion 2>/dev/null | grep -c 'detector parou')"

HOLD=$(sql "SELECT count(*) FILTER (WHERE motion_hold) || ' em espera, ' || count(*) FILTER (WHERE NOT motion_hold) || ' mantido(s); validade em espera ≈ ' ||
              coalesce(round(avg(extract(epoch FROM expires_at - started_at) / 60) FILTER (WHERE motion_hold)), 0) || ' min'
         FROM recording_segments WHERE camera_id = '$CAM2' AND started_at >= '$T_MOV' AND state IN ('writing', 'verified')")
held_ok() { [ "$(sql "SELECT count(*) FROM recording_segments WHERE camera_id = '$CAM2' AND started_at >= '$T_STILL' AND motion_hold")" -ge 1 ]; }
wait_until 120 held_ok && h_ok=1 || h_ok=0
HOLD=$(sql "SELECT count(*) FILTER (WHERE motion_hold) || ' em espera, ' || count(*) FILTER (WHERE NOT motion_hold) || ' mantido(s); validade em espera ≈ ' ||
              coalesce(round(avg(extract(epoch FROM expires_at - started_at) / 60) FILTER (WHERE motion_hold)), 0) || ' min'
         FROM recording_segments WHERE camera_id = '$CAM2' AND started_at >= '$T_MOV' AND state IN ('writing', 'verified')")
if [ "$GLOBAL" != true ]; then
  skip V5 "Gravação só com movimento" "gravação geral desligada em Configurações"
else
  record V5 "$(ok_if "$([ $k_ok = 1 ] && [ $h_ok = 1 ] && echo 1)")" \
    "Gravação só com movimento: espera de 1 h e retenção normal no que teve movimento" "segmentos do teste: $HOLD"
fi

ALARM=$(sql "SELECT coalesce(string_agg(DISTINCT coalesce(alarm_status, 'pendente'), ', '), 'nenhum') FROM motion_events WHERE camera_id = '$CAM2' AND created_at >= '$T_MOV'")
PEND=$(sql "SELECT count(*) FROM motion_events WHERE camera_id = '$CAM2' AND created_at >= '$T_MOV' AND alarm_status IS NULL AND created_at < now() - interval '20 seconds'")
record V6 "$(ok_if "$([ "$PEND" = 0 ] && [ "$ALARM" != nenhum ] && echo 1)")" \
  "Alarme decide cada movimento (e-mail desligado no teste)" "decisões: $ALARM; pendentes há mais de 20 s: $PEND"
stop_tx CAM-002

# ------------------------------------------------------------------ V7: firewall
if command -v topcam-host >/dev/null 2>&1 && nft list table inet topcam_fw >/dev/null 2>&1; then
  # O serviço do host reaplica as regras sozinho no minuto seguinte à atualização.
  fw() { nft list table inet topcam_fw | grep -q '2525'; }
  wait_until 120 fw && f_ok=1 || f_ok=0
  record V7 "$(ok_if "$f_ok")" "Firewall do host libera a porta 2525" "$(nft list table inet topcam_fw | grep -o 'tcp dport {[^}]*}' | head -1)"
else
  skip V7 "Firewall do host libera a porta 2525" "serviço do host (firewall) não instalado nesta máquina"
fi

# ------------------------------------------------------------------ M1: testes
TEST_LOG="reports/movimento-${STAMP}-testes.log"
if [ "$RUN_TESTS" = 1 ]; then
  log "M1: lint + testes"
  dc --profile test build tests >/dev/null 2>&1 || log "aviso: falha ao construir a imagem de testes"
  dc --profile test run --rm -e NO_COLOR=1 tests sh -c "pnpm lint && pnpm test" >"$TEST_LOG" 2>&1; rc=$?
  summary=$(sed 's/\x1b\[[0-9;]*m//g' "$TEST_LOG" | grep -E "^\s+Tests\s" | tail -n1 | xargs)
  record M1 "$([ $rc -eq 0 ] && echo PASS || echo FAIL)" "Lint e testes automatizados" "${summary:-sem resumo} (log: $TEST_LOG)"
else
  skip M1 "Lint e testes automatizados" "--skip-tests"
fi

cleanup
trap - EXIT
OUT="reports/movimento-${STAMP}.md"
{
  echo "# Aceite — movimento, gravação por movimento e alarme — $(date '+%d/%m/%Y %H:%M')"
  echo
  echo "Host: $(hostname) · commit: $(git rev-parse --short HEAD 2>/dev/null || echo '?')"
  echo
  echo "| # | Critério | Resultado | Evidência |"
  echo "|---|---|---|---|"
  printf '%s\n' "${RESULTS[@]}"
  echo
  echo "**Total: $(( ${#RESULTS[@]} - FAILS - SKIPS ))/$(( ${#RESULTS[@]} - SKIPS )) aprovados$([ "$SKIPS" -gt 0 ] && echo ", $SKIPS pulado(s)").**"
} >"$OUT"
echo; cat "$OUT"; echo; log "relatório: $OUT"
[ "$FAILS" -eq 0 ]
