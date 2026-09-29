#!/usr/bin/env bash
# TopCam — teste de aceite da Fase 7 (monitoramento, alertas, e-mail e relatórios).
#
# Os e-mails vão para um servidor de e-mail de TESTE (Mailpit, perfil "test"), nunca para
# o Gmail. A configuração de e-mail salva pelo usuário é guardada no início e devolvida
# exatamente igual no fim. Só a CAM-001 da Empresa Alfa (de teste) sai do ar, com o
# transmissor de teste; a TWG 6608 e as demais câmeras reais não são tocadas.
#
#   M1  Prometheus coletando (node-exporter, servidor de mídia) e o worker lendo a rede
#   M2  Integrações → e-mail: validação, senha nunca devolvida, e-mail de teste entregue
#   M3  câmera cai → alerta "sem sinal" e e-mail em até 60 s
#   M4  câmera volta → alerta fecha sozinho e e-mail de "resolvido"
#   M5  alertas: reconhecer/resolver com auditoria; outro cliente não vê nem mexe
#   M6  dashboard, relatório de disponibilidade (JSON e CSV), eventos com filtro, acesso do cliente
#   M7  histórico: amostras do dashboard e horas de disponibilidade sendo gravadas
#   M8  lint e testes automatizados
# Relatório em reports/phase7-<data>.md. Duração: ~8 min.
#
# Uso:  scripts/accept-phase7.sh [--no-build] [--skip-tests]
#   nohup scripts/accept-phase7.sh --no-build > /root/aceite7.log 2>&1 &

set -uo pipefail
cd "$(dirname "$0")/.."

exec 9>/tmp/topcam-aceite.lock
if ! flock -n 9; then
  echo "Já existe um teste de aceite em execução nesta máquina. Aguarde terminar (ps aux | grep accept-phase)." >&2
  exit 3
fi

BUILD=1
RUN_TESTS=1
while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) BUILD=0; shift ;;
    --skip-tests) RUN_TESTS=0; shift ;;
    *) echo "opção desconhecida: $1" >&2; exit 2 ;;
  esac
done

[ -f .env ] || { echo "Arquivo .env não encontrado." >&2; exit 2; }
set -a; . ./.env; set +a

# shellcheck disable=SC2086
dc() { docker compose ${COMPOSE_ARGS:-} "$@"; }
sql() { dc exec -T postgres psql -U topcam_owner -d topcam -Atq -c "$1" 2>/dev/null | tr -d '\r'; }
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
now_s() { date +%s; }

mkdir -p reports
STAMP=$(date +%Y%m%d-%H%M%S)
REPORT="reports/phase7-${STAMP}.md"
RUN=$(date +%H%M%S)
ACC_EMAIL="aceite7-${RUN}@topcam.local"
MAIL_TO="alertas-${RUN}@aceite.local"
RESULTS=()
FAILS=0
TENANT=empresa-alfa

record() {
  RESULTS+=("| $1 | $3 | $([ "$2" = PASS ] && echo '✅ PASSOU' || echo '❌ FALHOU') | $4 |")
  [ "$2" = PASS ] || FAILS=$((FAILS + 1))
  log "$1 $2 — $4"
}
pass_if() { [ "$1" = 1 ] && echo PASS || echo FAIL; }
wait_until() {
  local timeout="$1"; shift
  local t0; t0=$(now_s)
  until "$@" >/dev/null 2>&1; do
    [ $(( $(now_s) - t0 )) -ge "$timeout" ] && return 1
    sleep 2
  done
}

cam_id() { sql "SELECT c.id FROM cameras c JOIN tenants t ON t.id = c.tenant_id WHERE t.slug = '$TENANT' AND c.code = '$1'"; }
key_of() { dc exec -T api node apps/api/dist/cli.js camera:show-key --tenant "$TENANT" --code "$1" --raw 2>/dev/null | tr -d '\r\n'; }
start_tx() { docker rm -f topcam-tx7-CAM-001 >/dev/null 2>&1; TX_CLOCK=1 dc --profile test run -d --rm --name topcam-tx7-CAM-001 test-transmitter publish "$(key_of CAM-001)" CAM-001 >/dev/null 2>&1; }
stop_tx() { docker rm -f topcam-tx7-CAM-001 >/dev/null 2>&1; }

GESTORES=""
stage() {
  local name="$1"; shift
  local envs=(-e "BASE=http://gateway" -e "RUN=$RUN" -e "ACC_EMAIL=$ACC_EMAIL" -e "ACC_TEMP=$ACC_TEMP"
    -e "CAM1=$CAM1" -e "ALFA=$ALFA" -e "SOL=$SOL" -e "MAIL_TO=$MAIL_TO" -e "T_START_ISO=$T_START_ISO")
  for kv in "$@"; do envs+=(-e "$kv"); done
  dc exec -T "${envs[@]}" api node --input-type=module - "$name" < scripts/accept-phase7.mjs
}
collect() {
  local line id st crit ev
  while IFS= read -r line; do
    case "$line" in
      RESULT\|*) IFS='|' read -r _ id st crit ev <<<"$line"; record "$id" "$st" "$crit" "$ev" ;;
      OUT\|GESTOR_*) GESTORES="${GESTORES},${line##*|}" ;;
      OUT\|*) local rest="${line#OUT|}"; id="${rest%%|*}"; printf -v "OUT_$id" '%s' "${rest#*|}" ;;
      ERROR\|*) record "ERRO" FAIL "Execução do roteiro" "${line#ERROR|}" ;;
    esac
  done
}
wait_mail() { # wait_mail <trecho do assunto> <desde (epoch s)> <timeout s>
  OUT_MAIL=""; OUT_MAILBODY=""
  collect < <(stage mail "SUBJECT=$1" "SINCE=$2" "TIMEOUT=$3" 2>&1)
}

# ------------------------------------------------------------------ ambiente
if [ "$BUILD" = 1 ]; then
  log "construindo e subindo o ambiente"
  dc up -d --build --wait >/dev/null 2>&1 || { dc ps; echo "falha ao subir o ambiente" >&2; exit 1; }
else
  dc up -d --wait >/dev/null 2>&1 || { dc ps; echo "falha ao subir o ambiente" >&2; exit 1; }
fi
log "subindo o servidor de e-mail de teste (Mailpit)"
dc --profile test up -d --wait mailpit >/dev/null 2>&1 || dc --profile test up -d mailpit >/dev/null 2>&1

CAM1=$(cam_id CAM-001)
[ -n "$CAM1" ] || { echo "CAM-001 da Empresa Alfa não encontrada (seed de demonstração)" >&2; exit 1; }
ALFA=$(sql "SELECT id FROM tenants WHERE slug = 'empresa-alfa'")
SOL=$(sql "SELECT id FROM tenants WHERE slug = 'condominio-sol'")
[ -n "$SOL" ] || { echo "cliente Condomínio Sol não encontrado (seed de demonstração)" >&2; exit 1; }
T_START=$(sql "SELECT now()")
T_START_ISO=$(sql "SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')")
# Configuração de e-mail do usuário (Gmail): guardada para devolver igual no fim.
PREV_SMTP_EXISTS=$(sql "SELECT count(*) FROM system_settings WHERE key = 'integrations.smtp'")
sql "CREATE TABLE IF NOT EXISTS aceite7_backup (k text PRIMARY KEY, v jsonb)" >/dev/null
sql "INSERT INTO aceite7_backup SELECT 'smtp', value FROM system_settings WHERE key = 'integrations.smtp'
     ON CONFLICT (k) DO NOTHING" >/dev/null   # interrompido antes: mantém o backup original

ACC_TEMP=$(dc exec -T api node apps/api/dist/cli.js user:create --email "$ACC_EMAIL" \
  --name "Aceite Fase 7" --role platform_admin --raw 2>&1 | tail -n1 | tr -d '\r')
[[ "$ACC_TEMP" =~ ^[A-Za-z0-9]{14}$ ]] || { echo "falha ao criar usuário de aceite: $ACC_TEMP" >&2; exit 1; }

CLEANED=0
cleanup() {
  [ "$CLEANED" = 1 ] && return
  CLEANED=1
  log "limpeza: e-mail do usuário restaurado, avisos de teste desfeitos, alerta de teste e usuários removidos"
  [ -n "${ALERT_ID:-}" ] && sql "DELETE FROM alerts WHERE id = $ALERT_ID" >/dev/null
  stage clean "GESTORES=$GESTORES" >/dev/null 2>&1
  dc exec -T api node apps/api/dist/cli.js user:delete --email "$ACC_EMAIL" >/dev/null 2>&1
  if [ "$PREV_SMTP_EXISTS" = 1 ]; then
    sql "UPDATE system_settings SET value = (SELECT v FROM aceite7_backup WHERE k = 'smtp') WHERE key = 'integrations.smtp'" >/dev/null
  else
    sql "DELETE FROM system_settings WHERE key = 'integrations.smtp'" >/dev/null
  fi
  sql "DROP TABLE IF EXISTS aceite7_backup" >/dev/null
  # Alertas reais que ganharam "e-mail enviado" durante o aceite (foram para o Mailpit):
  # voltam a "não avisado", para o Gmail do usuário avisar de verdade.
  sql "UPDATE alerts SET notified_severity = NULL, notified_at = NULL WHERE notified_at >= '$T_START' AND camera_id IS DISTINCT FROM '$CAM1'" >/dev/null
  sql "UPDATE alerts SET resolved_notified_at = NULL WHERE resolved_notified_at >= '$T_START' AND camera_id IS DISTINCT FROM '$CAM1'" >/dev/null
  sql "DELETE FROM notifications WHERE recipients LIKE '%@aceite.local%'" >/dev/null
  stop_tx
  dc --profile test stop mailpit >/dev/null 2>&1
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM
trap 'cleanup; exit 129' HUP

# ------------------------------------------------------------------ M1: Prometheus
log "M1: Prometheus"
collect < <(stage prom 2>&1)
net() { [ -n "$(sql "SELECT metrics->'host'->'network'->>'rx_bps' FROM ingest_nodes ORDER BY created_at LIMIT 1")" ]; }
wait_until 75 net
M1B=$(sql "SELECT coalesce(metrics->'host'->'services'->>'prometheus', '?') || '|' || coalesce(round((metrics->'host'->'network'->>'rx_bps')::numeric / 1e6, 2)::text, '-') FROM ingest_nodes ORDER BY created_at LIMIT 1")
IFS='|' read -r m1_prom m1_rx <<<"$M1B"
record M1b "$(pass_if "$([ "$m1_prom" = ok ] && [ "$m1_rx" != - ] && echo 1)")" \
  "Worker lê o Prometheus (serviço ok e tráfego de rede na tela Servidores)" \
  "prometheus=${m1_prom}; rede recebendo ${m1_rx} Mb/s"

# ------------------------------------------------------------------ M2: e-mail
log "M2: Integrações → e-mail (Mailpit)"
collect < <(stage smtp 2>&1)
sleep 20   # alertas abertos antes do aceite saem agora (vão para o Mailpit; desfeito no fim)

# ------------------------------------------------------------------ M3/M4: câmera cai e volta
log "M3: CAM-001 no ar pelo transmissor de teste"
start_tx
online() { [[ "$(sql "SELECT status FROM cameras WHERE id = '$CAM1'")" =~ ^(ao_vivo|gravando)$ ]]; }
wait_until 120 online || log "aviso: CAM-001 não ficou no ar"
no_offline_alert() { [ "$(sql "SELECT count(*) FROM alerts WHERE dedup_key = 'camera_offline:$CAM1' AND status <> 'resolved'")" = 0 ]; }
wait_until 30 no_offline_alert
sleep 20   # aviso de "resolvido" de alguma queda anterior sai antes da medição
log "M3: derrubando a CAM-001"
T_STOP=$(now_s)
stop_tx
alert_open() { [ "$(sql "SELECT count(*) FROM alerts WHERE dedup_key = 'camera_offline:$CAM1' AND status <> 'resolved'")" = 1 ]; }
wait_until 60 alert_open
T_ALERT=$(now_s)
A3=$(sql "SELECT severity || '|' || title FROM alerts WHERE dedup_key = 'camera_offline:$CAM1' AND status <> 'resolved'")
IFS='|' read -r a3_sev a3_title <<<"$A3"
wait_mail "CAM-001 · " "$T_STOP" 75
m3_secs=""; m3_subject=""; [ -n "${OUT_MAIL:-}" ] && { m3_secs="${OUT_MAIL%% *}"; m3_subject="${OUT_MAIL#* }"; }
ok=$([ "$a3_sev" = error ] && [ -n "$m3_subject" ] && [ "${m3_secs:-999}" -le 60 ] && [[ "$m3_subject" == *"sem sinal"* ]] && [[ "${OUT_MAILBODY:-}" == */eventos* ]] && echo 1)
record M3 "$(pass_if "$ok")" \
  "Câmera cai → alerta \"sem sinal\" e e-mail em até 60 s (com link para o painel)" \
  "alerta em $((T_ALERT - T_STOP)) s: ${a3_title:-nenhum} (${a3_sev:-?}); e-mail em ${m3_secs:-—} s: ${m3_subject:-não chegou}"

log "M4: CAM-001 volta"
T_BACK=$(now_s)
start_tx
alert_closed() { no_offline_alert; }
wait_until 120 alert_closed
T_CLOSED=$(now_s)
wait_mail "[TopCam] Resolvido" "$T_BACK" 60
m4_secs=""; m4_subject=""; [ -n "${OUT_MAIL:-}" ] && { m4_secs="${OUT_MAIL%% *}"; m4_subject="${OUT_MAIL#* }"; }
record M4 "$(pass_if "$(alert_closed && [ -n "$m4_subject" ] && [[ "${OUT_MAILBODY:-}" == *CAM-001* ]] && echo 1)")" \
  "Câmera volta → alerta fecha sozinho e e-mail de \"resolvido\"" \
  "alerta fechado em $((T_CLOSED - T_BACK)) s; e-mail em ${m4_secs:-—} s: ${m4_subject:-não chegou}"

# ------------------------------------------------------------------ M5: alertas pela API
log "M5: alertas pela API"
ALERT_ID=$(sql "INSERT INTO alerts (dedup_key, rule, severity, title, tenant_id, camera_id)
                VALUES ('aceite7:$RUN', 'aceite7', 'warning', 'Alerta de teste do aceite 7', '$ALFA', '$CAM1') RETURNING id")
collect < <(stage alerts "ALERT_ID=$ALERT_ID" 2>&1)

# ------------------------------------------------------------------ M6: dashboard e relatórios
log "M6: dashboard, relatório e eventos"
has_hourly() { [ "$(sql "SELECT count(*) FROM camera_hourly WHERE camera_id = '$CAM1' AND observed_s > 0")" -ge 1 ]; }
wait_until 75 has_hourly
collect < <(stage reports 2>&1)

# ------------------------------------------------------------------ M7: histórico
M7=$(sql "SELECT (SELECT count(*) FROM status_samples WHERE sampled_at > now() - interval '24 hours') || '|' ||
                 (SELECT count(DISTINCT camera_id) FROM camera_hourly WHERE hour > now() - interval '2 hours') || '|' ||
                 coalesce((SELECT max(sampled_at)::timestamp(0)::text FROM status_samples), '-')")
IFS='|' read -r m7_samples m7_cams m7_last <<<"$M7"
record M7 "$(pass_if "$([ "${m7_samples:-0}" -ge 1 ] && [ "${m7_cams:-0}" -ge 1 ] && echo 1)")" \
  "Histórico gravado: amostras do dashboard (5 min) e horas de disponibilidade por câmera" \
  "${m7_samples} amostra(s) em 24 h (última ${m7_last}); ${m7_cams} câmera(s) com horas nas últimas 2 h"
stop_tx

# ------------------------------------------------------------------ M8: testes
TEST_LOG="reports/phase7-${STAMP}-testes.log"
if [ "$RUN_TESTS" = 1 ]; then
  log "M8: lint + testes (a imagem de testes é reconstruída se o código mudou)"
  dc --profile test build tests >/dev/null 2>&1 || log "aviso: falha ao construir a imagem de testes"
  dc --profile test run --rm -e NO_COLOR=1 tests sh -c "pnpm lint && pnpm test" >"$TEST_LOG" 2>&1; rc=$?
  summary=$(sed 's/\x1b\[[0-9;]*m//g' "$TEST_LOG" | grep -E "^\s+Tests\s" | tail -n1 | xargs)
  record M8 "$([ $rc -eq 0 ] && echo PASS || echo FAIL)" "Lint e testes automatizados" "${summary:-sem resumo} (log: $TEST_LOG)"
else
  record M8 FAIL "Lint e testes automatizados" "não executado (--skip-tests)"
fi

# ------------------------------------------------------------------ relatório
{
  echo "# Aceite da Fase 7 — $(date '+%d/%m/%Y %H:%M')"
  echo
  echo "Host: $(hostname) · versão: ${TOPCAM_VERSION:-?} · commit: $(git rev-parse --short HEAD 2>/dev/null || echo '?')"
  echo
  echo "| # | Critério | Resultado | Evidência |"
  echo "|---|---|---|---|"
  printf '%s\n' "${RESULTS[@]}"
  echo
  echo "**Total: $(( ${#RESULTS[@]} - FAILS ))/${#RESULTS[@]} aprovados.**"
  echo
  echo "E-mails do aceite foram para o Mailpit (servidor de teste). A configuração de e-mail do painel foi restaurada."
  echo "Telas (Dashboard, Eventos e Alertas, Relatórios, Integrações): E2E e2e/monitoramento.spec.ts."
} >"$REPORT"

echo
cat "$REPORT"
echo
log "relatório: $REPORT"
[ "$FAILS" -eq 0 ]
