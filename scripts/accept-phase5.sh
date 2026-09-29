#!/usr/bin/env bash
# TopCam — teste de aceite da Fase 5 (gravações: calendário, reprodução e exportação).
#
# Usa a CAM-001 da Empresa Alfa (câmera de TESTE) gravando com o transmissor de teste,
# provoca uma queda de 30 s (lacuna) e verifica, pela porta do painel (gateway):
#
#   G1  servidor de reprodução ligado e só interno (porta 9996 não publicada)
#   G2  calendário com o dia gravado; linha do tempo com a lacuna da queda
#   G3  reprodução pelo gateway com endereço temporário (fMP4 válido do trecho pedido)
#   G4  reprodução recusada: sem token, adulterado, outra câmera, token do ao vivo,
#       /list, mais de 1 h, formato errado, acesso direto ao servidor sem senha
#   G5  visualizador: sem "pode reproduzir" nada; retirar a permissão corta o endereço
#   G6  exportação MP4: exige "pode exportar", limites, arquivo válido, auditoria
#   G7  exportação atravessando a lacuna traz todos os trechos gravados
#   G8  lint e testes automatizados
# A tela (player, velocidades, calendário, linha do tempo, salto de lacunas e a precisão
# do horário) é verificada no navegador pelo E2E (e2e/gravacoes.spec.ts).
# Ao final a CAM-001 de teste volta ao estado anterior e as gravações de teste são
# apagadas. Câmeras reais (ex.: a TWG 6608) não são alteradas nem interrompidas.
# Relatório em reports/phase5-<data>.md. Duração: ~8 min.
#
# Uso:  scripts/accept-phase5.sh [--no-build] [--skip-tests]
# Rodar sem depender da conexão SSH:
#   nohup scripts/accept-phase5.sh --no-build > /root/aceite5.log 2>&1 &

set -uo pipefail
cd "$(dirname "$0")/.."

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
REPORT="reports/phase5-${STAMP}.md"
RUN=$(date +%H%M%S)
ACC_EMAIL="aceite5-${RUN}@topcam.local"
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
    sleep 3
  done
}

cam_id() { sql "SELECT c.id FROM cameras c JOIN tenants t ON t.id = c.tenant_id WHERE t.slug = '$TENANT' AND c.code = '$1'"; }
status_of() { sql "SELECT status FROM cameras WHERE id = '$1'"; }
key_of() { dc exec -T api node apps/api/dist/cli.js camera:show-key --tenant "$TENANT" --code "$1" --raw 2>/dev/null | tr -d '\r\n'; }
start_tx() { docker rm -f topcam-tx5-CAM-001 >/dev/null 2>&1; TX_CLOCK=1 dc --profile test run -d --rm --name topcam-tx5-CAM-001 test-transmitter publish "$(key_of CAM-001)" CAM-001 >/dev/null 2>&1; }
stop_tx() { docker rm -f topcam-tx5-CAM-001 >/dev/null 2>&1; }
reconcile() { sql "INSERT INTO durable_jobs (type, payload) VALUES ('mediamtx.reconcile', '{\"reason\":\"aceite5\"}')" >/dev/null; dc exec -T redis redis-cli publish topcam:jobs:wake 1 >/dev/null 2>&1; }

stage() {
  local name="$1"; shift
  local envs=(-e "BASE=http://gateway" -e "RUN=$RUN" -e "ACC_EMAIL=$ACC_EMAIL" -e "CAM1=$CAM1" -e "CAM2=$CAM2"
              -e "EXPORT_MAX_S=${EXPORT_MAX_S:-3600}")
  for kv in "$@"; do envs+=(-e "$kv"); done
  dc exec -T "${envs[@]}" api node --input-type=module - "$name" < scripts/accept-phase5.mjs
}

collect() {
  local line id st crit ev
  while IFS= read -r line; do
    case "$line" in
      RESULT\|*) IFS='|' read -r _ id st crit ev <<<"$line"; record "$id" "$st" "$crit" "$ev" ;;
      OUT\|*) IFS='|' read -r _ id ev <<<"$line"; printf -v "OUT_$id" '%s' "$ev" ;;
      ERROR\|*) record "ERRO" FAIL "Execução do roteiro" "${line#ERROR|}" ;;
    esac
  done
}

# ------------------------------------------------------------------ ambiente
if [ "$BUILD" = 1 ]; then
  log "construindo e subindo o ambiente"
  dc up -d --build --wait >/dev/null 2>&1 || { dc ps; echo "falha ao subir o ambiente" >&2; exit 1; }
else
  dc up -d --wait >/dev/null 2>&1 || { dc ps; echo "falha ao subir o ambiente" >&2; exit 1; }
fi

CAM1=$(cam_id CAM-001)
CAM2=$(cam_id CAM-002)
[ -n "$CAM1" ] && [ -n "$CAM2" ] || { echo "CAM-001/CAM-002 da Empresa Alfa não encontradas (seed de demonstração)" >&2; exit 1; }
PREV_REC=$(sql "SELECT recording_enabled FROM cameras WHERE id = '$CAM1'")
PREV_RET=$(sql "SELECT coalesce(retention_policy_id::text, '') FROM cameras WHERE id = '$CAM1'")
T_START=$(sql "SELECT now()")

ACC_TEMP=$(dc exec -T api node apps/api/dist/cli.js user:create --email "$ACC_EMAIL" \
  --name "Aceite Fase 5" --role platform_admin --raw 2>&1 | tail -n1 | tr -d '\r')
[[ "$ACC_TEMP" =~ ^[A-Za-z0-9]{14}$ ]] || { echo "falha ao criar usuário de aceite: $ACC_TEMP" >&2; exit 1; }

CLEANED=0
cleanup() {
  [ "$CLEANED" = 1 ] && return
  CLEANED=1
  log "limpeza: transmissor, usuários de aceite, CAM-001 de teste volta ao estado anterior, gravações de teste apagadas"
  stop_tx
  stage clean "VIEWER_ID=${OUT_VIEWER_ID:-}" >/dev/null 2>&1
  dc exec -T api node apps/api/dist/cli.js user:delete --email "$ACC_EMAIL" >/dev/null 2>&1
  sql "UPDATE cameras SET recording_enabled = '$PREV_REC'::boolean, retention_policy_id = NULLIF('$PREV_RET', '')::uuid WHERE id = '$CAM1'" >/dev/null
  if [ "$PREV_REC" != t ]; then
    sql "UPDATE recording_segments SET expires_at = now() - interval '1 second' WHERE camera_id = '$CAM1' AND state NOT IN ('deleting', 'deleted')" >/dev/null
  fi
  reconcile
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM
trap 'cleanup; exit 129' HUP   # conexão SSH caiu

# ------------------------------------------------------------------ G1: servidor de reprodução
PB_CFG=$(dc exec -T worker node -e '
  fetch("http://mediamtx:9997/v3/config/global/get").then((r) => r.json()).then((j) => console.log(`${j.playback}|${j.playbackAddress}`));' 2>/dev/null | tr -d '\r')
PUBLISHED=$(dc port mediamtx 9996 2>/dev/null)
record G1 "$(pass_if "$([ "${PB_CFG%%|*}" = true ] && [ -z "$PUBLISHED" ] && echo 1)")" \
  "Servidor de reprodução ligado e só na rede interna" \
  "playback=${PB_CFG%%|*}, endereço ${PB_CFG#*|}; porta 9996 publicada: ${PUBLISHED:-não}"

# ------------------------------------------------------------------ preparação: gravação + queda
log "preparação: CAM-001 de teste gravando (24 h) com o transmissor de teste"
sql "UPDATE cameras SET recording_enabled = true,
       retention_policy_id = coalesce(retention_policy_id, (SELECT id FROM retention_policies WHERE tenant_id IS NULL AND retention_hours = 24 LIMIT 1))
     WHERE id = '$CAM1'" >/dev/null
reconcile
start_tx
is_recording() { [ "$(status_of "$CAM1")" = gravando ]; }
wait_until 180 is_recording || log "aviso: CAM-001 não chegou a \"gravando\" em 3 min"
enough() { [ "$(sql "SELECT count(*) FROM recording_segments WHERE camera_id = '$CAM1' AND state = 'verified' AND started_at >= '$T_START'")" -ge 3 ]; }
log "preparação: aguardando 3 segmentos conferidos"
wait_until 240 enough

log "preparação: queda de 30 s na CAM-001 (lacuna)"
GAP_AT=$(( $(date +%s%3N) ))
stop_tx
sleep 30
start_tx
after_gap() { [ "$(sql "SELECT count(*) FROM recording_segments WHERE camera_id = '$CAM1' AND state = 'verified' AND started_at > to_timestamp($GAP_AT / 1000.0)")" -ge 2 ]; }
log "preparação: aguardando 2 segmentos conferidos depois da queda"
wait_until 240 after_gap

# ------------------------------------------------------------------ G2–G7
log "G2–G7: calendário, reprodução, segurança, permissões e exportação"
collect < <(stage check "ACC_TEMP=$ACC_TEMP" "GAP_AT=$GAP_AT" 2>&1)

# ------------------------------------------------------------------ G8: testes
TEST_LOG="reports/phase5-${STAMP}-testes.log"
if [ "$RUN_TESTS" = 1 ]; then
  log "G8: lint + testes (a imagem de testes é reconstruída se o código mudou)"
  dc --profile test build tests >/dev/null 2>&1 || log "aviso: falha ao construir a imagem de testes"
  dc --profile test run --rm -e NO_COLOR=1 tests sh -c "pnpm lint && pnpm test" >"$TEST_LOG" 2>&1; rc=$?
  summary=$(sed 's/\x1b\[[0-9;]*m//g' "$TEST_LOG" | grep -E "^\s+Tests\s" | tail -n1 | xargs)
  record G8 "$([ $rc -eq 0 ] && echo PASS || echo FAIL)" "Lint e testes automatizados" "${summary:-sem resumo} (log: $TEST_LOG)"
else
  record G8 FAIL "Lint e testes automatizados" "não executado (--skip-tests)"
fi

# ------------------------------------------------------------------ relatório
{
  echo "# Aceite da Fase 5 — $(date '+%d/%m/%Y %H:%M')"
  echo
  echo "Host: $(hostname) · versão: ${TOPCAM_VERSION:-?} · commit: $(git rev-parse --short HEAD 2>/dev/null || echo '?')"
  echo
  echo "| # | Critério | Resultado | Evidência |"
  echo "|---|---|---|---|"
  printf '%s\n' "${RESULTS[@]}"
  echo
  echo "**Total: $(( ${#RESULTS[@]} - FAILS ))/${#RESULTS[@]} aprovados.**"
  echo
  echo "Tela (player, velocidades, calendário, linha do tempo, salto de lacunas, precisão do horário): E2E e2e/gravacoes.spec.ts."
} >"$REPORT"

echo
cat "$REPORT"
echo
log "relatório: $REPORT"
[ "$FAILS" -eq 0 ]
