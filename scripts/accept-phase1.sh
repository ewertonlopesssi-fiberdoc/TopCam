#!/usr/bin/env bash
# TopCam — teste de aceite da Fase 1 (fundação + ingestão RTMP autenticada).
#
# Executa os 11 critérios do plano contra o ambiente Docker Compose real e grava
# um relatório em reports/phase1-<data>.md. Usa o transmissor de teste (ffmpeg)
# no lugar das câmeras físicas.
#
# Uso:  scripts/accept-phase1.sh [--no-build] [--live-minutes N]
#   --no-build        não reconstrói as imagens
#   --live-minutes N  tempo mínimo com as 5 transmissões no ar antes de conferir
#                     que nada foi gravado (padrão: 10)
# Variável COMPOSE_ARGS: argumentos extras para "docker compose" (ex.: -f outro.yaml).

set -uo pipefail
cd "$(dirname "$0")/.."

BUILD=1
LIVE_MINUTES=10
while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) BUILD=0; shift ;;
    --live-minutes) LIVE_MINUTES="$2"; shift 2 ;;
    *) echo "opção desconhecida: $1" >&2; exit 2 ;;
  esac
done

[ -f .env ] || { echo "Arquivo .env não encontrado. Rode scripts/generate-env.sh primeiro." >&2; exit 2; }
set -a; . ./.env; set +a

# shellcheck disable=SC2086
dc() { docker compose ${COMPOSE_ARGS:-} "$@"; }
sql() { dc exec -T postgres psql -U topcam_owner -d topcam -Atq -c "$1" 2>/dev/null; }
now_s() { date +%s; }
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

mkdir -p reports
STAMP=$(date +%Y%m%d-%H%M%S)
REPORT="reports/phase1-${STAMP}.md"
RESULTS=()
FAILS=0

record() { # record <id> <PASS|FAIL> <critério> <evidência>
  RESULTS+=("| $1 | $3 | $([ "$2" = PASS ] && echo '✅ PASSOU' || echo '❌ FALHOU') | $4 |")
  [ "$2" = PASS ] || FAILS=$((FAILS + 1))
  log "C$1 $2 — $4"
}

# wait_for <timeout_s> <comando...>: repete até o comando ter sucesso; imprime segundos gastos.
wait_for() {
  local timeout="$1"; shift
  local start; start=$(now_s)
  while true; do
    if "$@" >/dev/null 2>&1; then echo $(( $(now_s) - start )); return 0; fi
    [ $(( $(now_s) - start )) -ge "$timeout" ] && { echo "$timeout"; return 1; }
    sleep 1
  done
}

TENANT=empresa-alfa
CAMS=(CAM-001 CAM-002 CAM-003 CAM-004 CAM-005)

cam_sql() { echo "(SELECT c.id FROM cameras c JOIN tenants t ON t.id = c.tenant_id WHERE t.slug = '$TENANT' AND c.code = '$1')"; }
cam_status() { sql "SELECT status FROM cameras WHERE id = $(cam_sql "$1")"; }
status_is() { [ "$(cam_status "$1")" = "$2" ]; }
get_key() { dc exec -T api node apps/api/dist/cli.js camera:show-key --tenant "$TENANT" --code "$1" --raw 2>/dev/null | tr -d '\r\n'; }
start_tx() { # start_tx <nome> <chave>
  docker rm -f "topcam-tx-$1" >/dev/null 2>&1
  dc --profile test run -d --rm --name "topcam-tx-$1" test-transmitter publish "$2" "$1" >/dev/null 2>&1
}
stop_tx() { docker rm -f "topcam-tx-$1" >/dev/null 2>&1; }
events_since() { # events_since <tipo> <T0> [condição extra]
  sql "SELECT count(*) FROM camera_events WHERE type = '$1' AND occurred_at >= '$2' ${3:-}"
}
mtx_source_id() { # id da conexão publicadora de um caminho
  dc exec -T mediamtx wget -q -O- "http://127.0.0.1:9997/v3/paths/get/live/$1" 2>/dev/null |
    sed -n 's/.*"source":{"type":"[^"]*","id":"\([^"]*\)".*/\1/p'
}
all_live() { for c in "${CAMS[@]}"; do status_is "$c" ao_vivo || return 1; done; }

cleanup() { for c in "${CAMS[@]}" CAM-004-old; do stop_tx "$c"; done; }
trap cleanup EXIT

log "TopCam — aceite da Fase 1 (relatório: $REPORT)"

# ------------------------------------------------------------------ C1
log "C1: subindo o ambiente"
T_UP=$(now_s)
if [ "$BUILD" = 1 ]; then dc up -d --build >/tmp/topcam-up.log 2>&1; else dc up -d >/tmp/topcam-up.log 2>&1; fi
all_healthy() {
  local out; out=$(dc ps --format '{{.Service}}={{.Health}}' 2>/dev/null)
  for s in postgres redis api worker mediamtx gateway; do echo "$out" | grep -q "^$s=healthy$" || return 1; done
}
if secs=$(wait_for 120 all_healthy); then
  record 1 PASS "Ambiente sobe com todos os serviços saudáveis em ≤ 2 min" "6 serviços healthy em ${secs}s após o up ($(( $(now_s) - T_UP ))s incluindo build)"
else
  record 1 FAIL "Ambiente sobe com todos os serviços saudáveis em ≤ 2 min" "$(dc ps --format '{{.Service}}={{.Status}}' | tr '\n' ' ')"
fi

T0=$(sql "SELECT now()")

# ------------------------------------------------------------------ C2
log "C2: reaplicando migrations"
FP_SQL="SELECT md5(string_agg(table_name||'.'||column_name||':'||data_type, ',' ORDER BY table_name, column_name)) FROM information_schema.columns WHERE table_schema = 'public'"
FP1=$(sql "$FP_SQL")
MIG_OUT=$(dc run --rm migrate 2>&1)
FP2=$(sql "$FP_SQL")
if echo "$MIG_OUT" | grep -q "migrations aplicadas: 0" && [ "$FP1" = "$FP2" ] && [ -n "$FP1" ]; then
  record 2 PASS "Migrations aplicam do zero e reaplicar não altera nada" "2ª execução: 0 aplicadas; assinatura do esquema igual (${FP1:0:8})"
else
  record 2 FAIL "Migrations aplicam do zero e reaplicar não altera nada" "saída: $(echo "$MIG_OUT" | grep migrations | tr '\n' ' ')"
fi

# ------------------------------------------------------------------ C3
log "C3: iniciando 5 transmissões de teste"
declare -A KEY
for c in "${CAMS[@]}"; do KEY[$c]=$(get_key "$c"); done
T_LIVE=$(now_s)
declare -A T_TX
for c in "${CAMS[@]}"; do T_TX[$c]=$(now_s); start_tx "$c" "${KEY[$c]}"; done
C3_OK=1; C3_EVID=""
for c in "${CAMS[@]}"; do
  secs=$(wait_for 20 status_is "$c" ao_vivo); rc=$?
  # Tempo medido do início do transmissor daquela câmera até o estado ao_vivo.
  total=$(( $(now_s) - T_TX[$c] ))
  info=$(sql "SELECT coalesce(video_codec,'-')||' '||coalesce(width::text,'-')||'x'||coalesce(height::text,'-')||' '||coalesce(fps::text,'-')||'fps' FROM cameras WHERE id = $(cam_sql "$c")")
  if [ $rc -ne 0 ] || [ "$total" -gt 15 ] || [[ "$info" == -* ]]; then C3_OK=0; fi
  C3_EVID+="$c: ${total}s ($info); "
done
[ $C3_OK = 1 ] && record 3 PASS "5 câmeras com chaves válidas chegam a 'ao_vivo' em ≤ 15 s, com codec/resolução/fps" "$C3_EVID" \
               || record 3 FAIL "5 câmeras com chaves válidas chegam a 'ao_vivo' em ≤ 15 s, com codec/resolução/fps" "$C3_EVID"

# ------------------------------------------------------------------ C4
log "C4: chave inválida"
BADKEY=$(openssl rand -base64 60 | tr -dc 'A-Za-z0-9' | head -c 40)
T4=$(sql "SELECT now()")
dc --profile test run --rm test-transmitter once "$BADKEY" 5 >/dev/null 2>&1; rc=$?
sleep 1
n=$(events_since auth_rejected "$T4" "AND data->>'reason' = 'unknown_key' AND source_ip IS NOT NULL")
ip=$(sql "SELECT host(source_ip) FROM camera_events WHERE type = 'auth_rejected' AND occurred_at >= '$T4' ORDER BY id DESC LIMIT 1")
if [ "$rc" -ne 0 ] && [ "${n:-0}" -ge 1 ]; then
  record 4 PASS "Chave inválida é recusada, com evento auth_rejected e IP de origem" "ffmpeg saiu com código $rc; $n evento(s); IP registrado: $ip"
else
  record 4 FAIL "Chave inválida é recusada, com evento auth_rejected e IP de origem" "código ffmpeg=$rc; eventos=$n"
fi

# ------------------------------------------------------------------ C5
log "C5: publicação duplicada"
SRC_BEFORE=$(mtx_source_id "${KEY[CAM-002]}")
T5=$(sql "SELECT now()")
dc --profile test run --rm test-transmitter once "${KEY[CAM-002]}" 6 >/dev/null 2>&1; rc=$?
sleep 2
SRC_AFTER=$(mtx_source_id "${KEY[CAM-002]}")
n=$(events_since duplicate_publish_rejected "$T5" "AND camera_id = $(cam_sql CAM-002)")
st=$(cam_status CAM-002)
if [ "$rc" -ne 0 ] && [ "${n:-0}" -ge 1 ] && [ "$st" = ao_vivo ] && [ -n "$SRC_BEFORE" ] && [ "$SRC_BEFORE" = "$SRC_AFTER" ]; then
  record 5 PASS "Segunda publicação na mesma chave é recusada e a original continua" "evento duplicate_publish_rejected; CAM-002 segue '$st' com a mesma conexão (${SRC_BEFORE:0:8})"
else
  record 5 FAIL "Segunda publicação na mesma chave é recusada e a original continua" "código=$rc eventos=$n status=$st conexão ${SRC_BEFORE:0:8}→${SRC_AFTER:0:8}"
fi

# ------------------------------------------------------------------ C6
log "C6: queda e retorno da CAM-003"
T6=$(sql "SELECT now()")
stop_tx CAM-003
secs_off=$(wait_for 20 status_is CAM-003 offline); rc1=$?
n=$(events_since stream_offline "$T6" "AND camera_id = $(cam_sql CAM-003)")
start_tx CAM-003 "${KEY[CAM-003]}"
secs_on=$(wait_for 25 status_is CAM-003 ao_vivo); rc2=$?
if [ $rc1 -eq 0 ] && [ "$secs_off" -le 15 ] && [ "${n:-0}" -ge 1 ] && [ $rc2 -eq 0 ]; then
  record 6 PASS "Queda → 'offline' em ≤ 15 s com evento; ao voltar → 'ao_vivo'" "offline em ${secs_off}s ($n evento stream_offline); de volta ao vivo em ${secs_on}s"
else
  record 6 FAIL "Queda → 'offline' em ≤ 15 s com evento; ao voltar → 'ao_vivo'" "offline rc=$rc1 em ${secs_off}s, eventos=$n; retorno rc=$rc2 em ${secs_on}s"
fi

# ------------------------------------------------------------------ C8
log "C8: isolamento entre clientes (RLS)"
SOL=$(sql "SELECT id FROM tenants WHERE slug = 'condominio-sol'")
app_sql() { # executa SQL (via stdin) como topcam_app, o papel usado pela API e pelo worker
  dc exec -T -e PGPASSWORD="$APP_DB_PASSWORD" postgres \
    psql -h 127.0.0.1 -U topcam_app -d topcam -Atq -v ON_ERROR_STOP=1 2>&1
}
R_SOL=$(app_sql <<SQL | tr '\n' ' '
SET app.scope = 'tenant';
SET app.tenant_id = '$SOL';
SELECT count(*) FROM cameras;
SELECT count(*) FROM cameras WHERE tenant_id <> '$SOL';
SELECT count(*) FROM camera_events WHERE tenant_id IS DISTINCT FROM '$SOL';
SQL
)
R_NONE=$(echo "SELECT count(*) FROM cameras;" | app_sql | tr -d ' \n')
if [ "$(echo "$R_SOL" | awk '{print $1,$2,$3}')" = "1 0 0" ] && [ "$R_NONE" = "0" ]; then
  record 8 PASS "Condomínio Sol não enxerga dados da Empresa Alfa, nem com consulta sem filtro" "escopo Sol: 1 câmera própria, 0 de outros clientes, 0 eventos alheios; sem escopo: $R_NONE"
else
  record 8 FAIL "Condomínio Sol não enxerga dados da Empresa Alfa, nem com consulta sem filtro" "escopo Sol: [$R_SOL] sem escopo: [$R_NONE]"
fi

# ------------------------------------------------------------------ C9
log "C9: rotação da chave da CAM-004"
CAM4_ID=$(sql "SELECT id FROM cameras WHERE id = $(cam_sql CAM-004)")
T9=$(sql "SELECT now()")
NEWKEY=$(dc exec -T api node apps/api/dist/cli.js camera:rotate-key --tenant "$TENANT" --code CAM-004 --raw 2>/dev/null | tr -d '\r\n')
kicked() { [ "$(events_since publisher_kicked "$T9")" -ge 1 ]; }
secs_kick=$(wait_for 30 kicked); rc_kick=$?
OLDKEY=${KEY[CAM-004]}
# Nova tentativa explícita com a chave antiga: deve ser recusada.
dc --profile test run --rm test-transmitter once "$OLDKEY" 5 >/dev/null 2>&1; rc_oldtx=$?
old_rejected() { [ "$(events_since auth_rejected "$T9" "AND data->>'reason' = 'unknown_key'")" -ge 1 ]; }
secs_rej=$(wait_for 10 old_rejected); rc_rej=$?
[ "$rc_oldtx" -ne 0 ] || rc_rej=1
not_live() { ! status_is CAM-004 ao_vivo; }
wait_for 20 not_live >/dev/null; rc_off=$?
st_between=$(cam_status CAM-004)
stop_tx CAM-004
start_tx CAM-004 "$NEWKEY"
new_live() { status_is CAM-004 ao_vivo && [ -n "$(mtx_source_id "$NEWKEY")" ]; }
secs_new=$(wait_for 25 new_live); rc_new=$?
CAM4_ID_AFTER=$(sql "SELECT id FROM cameras WHERE id = $(cam_sql CAM-004)")
KEY[CAM-004]=$NEWKEY
if [ ${#NEWKEY} -eq 40 ] && [ $rc_kick -eq 0 ] && [ $rc_rej -eq 0 ] && [ $rc_off -eq 0 ] && [ $rc_new -eq 0 ] && [ "$CAM4_ID" = "$CAM4_ID_AFTER" ]; then
  record 9 PASS "Rotação: chave antiga recusada, nova aceita, mesmo ID da câmera" "publicador antigo desconectado em ${secs_kick}s; nova tentativa com a chave antiga recusada (ffmpeg código $rc_oldtx, evento auth_rejected); estado entre as chaves: '$st_between'; chave nova ao vivo em ${secs_new}s; ID ${CAM4_ID:0:8} mantido"
else
  record 9 FAIL "Rotação: chave antiga recusada, nova aceita, mesmo ID da câmera" "kick rc=$rc_kick rejeição rc=$rc_rej offline rc=$rc_off ($st_between) nova rc=$rc_new id ${CAM4_ID:0:8}/${CAM4_ID_AFTER:0:8}"
fi

# ------------------------------------------------------------------ C10
log "C10: reinício da API e do MediaMTX"
declare -A SRC
for c in "${CAMS[@]}"; do SRC[$c]=$(mtx_source_id "${KEY[$c]}"); done
dc restart api >/dev/null 2>&1
api_ok() { dc ps --format '{{.Service}}={{.Health}}' | grep -q '^api=healthy$'; }
wait_for 60 api_ok >/dev/null
sleep 3
same=0; for c in "${CAMS[@]}"; do [ -n "${SRC[$c]}" ] && [ "$(mtx_source_id "${KEY[$c]}")" = "${SRC[$c]}" ] && same=$((same + 1)); done
live_after_api=$(wait_for 20 all_live); rc_api=$?
dc restart mediamtx >/dev/null 2>&1
secs_mtx=$(wait_for 90 all_live); rc_mtx=$?
if [ "$same" -eq 5 ] && [ $rc_api -eq 0 ] && [ $rc_mtx -eq 0 ]; then
  record 10 PASS "Reinício da API não derruba transmissões; reinício do MediaMTX se recupera" "API: 5/5 conexões intactas; MediaMTX: 5 câmeras ao vivo de novo em ${secs_mtx}s"
else
  record 10 FAIL "Reinício da API não derruba transmissões; reinício do MediaMTX se recupera" "conexões intactas após reinício da API: $same/5 (rc=$rc_api); MediaMTX rc=$rc_mtx em ${secs_mtx}s"
fi

# ------------------------------------------------------------------ C11
log "C11: testes automatizados e lint (contêiner de testes)"
if [ "$BUILD" = 1 ]; then dc --profile test build tests >/tmp/topcam-tests-build.log 2>&1; fi
TEST_LOG="reports/phase1-${STAMP}-tests.log"
dc --profile test run --rm -e NO_COLOR=1 tests sh -c "pnpm lint && pnpm test" >"$TEST_LOG" 2>&1; rc=$?
sed -i 's/\x1b\[[0-9;]*m//g' "$TEST_LOG"
TEST_OUT=$(cat "$TEST_LOG")
summary=$(echo "$TEST_OUT" | grep -E "^ *(Test Files|Tests) " | sed 's/  */ /g' | tr '\n' ';')
[ $rc -eq 0 ] && record 11 PASS "Testes unitários e de integração 100% aprovados; lint sem erros" "${summary:-ok}" \
              || record 11 FAIL "Testes unitários e de integração 100% aprovados; lint sem erros" "código $rc; ${summary:-veja a saída}"

# ------------------------------------------------------------------ C7
elapsed=$(( $(now_s) - T_LIVE ))
remaining=$(( LIVE_MINUTES * 60 - elapsed ))
if [ $remaining -gt 0 ]; then
  log "C7: aguardando ${remaining}s para completar ${LIVE_MINUTES} min com as transmissões no ar"
  sleep "$remaining"
fi
live_count=0; for c in "${CAMS[@]}"; do status_is "$c" ao_vivo && live_count=$((live_count + 1)); done
FILES=$(dc exec -T mediamtx find /recordings -type f 2>/dev/null | wc -l | tr -d ' ')
SEGS=$(sql "SELECT count(*) FROM recording_segments")
REC_CONFS=$(dc exec -T mediamtx wget -q -O- http://127.0.0.1:9997/v3/config/paths/list 2>/dev/null | grep -o '"record":true' | wc -l | tr -d ' ')
mins=$(( ($(now_s) - T_LIVE) / 60 ))
if [ "$FILES" = "0" ] && [ "$SEGS" = "0" ] && [ "$REC_CONFS" = "0" ] && [ "$live_count" -eq 5 ]; then
  record 7 PASS "Após ${LIVE_MINUTES} min com 5 transmissões: 0 arquivos e 0 segmentos" "${mins} min no ar; $live_count/5 ao vivo; arquivos=$FILES; recording_segments=$SEGS; caminhos com record=true: $REC_CONFS"
else
  record 7 FAIL "Após ${LIVE_MINUTES} min com 5 transmissões: 0 arquivos e 0 segmentos" "ao vivo=$live_count/5 arquivos=$FILES segmentos=$SEGS record=true: $REC_CONFS"
fi

# ------------------------------------------------------------------ relatório
EVENTS=$(sql "SELECT type || ': ' || count(*) FROM camera_events WHERE occurred_at >= '$T0' GROUP BY type ORDER BY type" | sed 's/^/- /')
CAMLIST=$(sql "SELECT '| '||t.slug||' | '||c.code||' | '||c.status||' | '||coalesce(c.video_codec,'-')||' '||coalesce(c.width::text,'')||'x'||coalesce(c.height::text,'')||' | '||coalesce(c.bitrate_kbps::text,'-')||' | '||c.recording_enabled||' |' FROM cameras c JOIN tenants t ON t.id = c.tenant_id ORDER BY t.slug, c.code")
IFS=$'\n' SORTED=($(printf '%s\n' "${RESULTS[@]}" | sort -t'|' -k2 -n)); unset IFS
{
  echo "# TopCam — Relatório de aceite da Fase 1"
  echo
  echo "- Data: $(date '+%d/%m/%Y %H:%M:%S %Z')"
  echo "- Host: $(hostname) · $(uname -sr) · Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null)"
  echo "- Versão: ${TOPCAM_VERSION:-0.1.0} · Transmissões de teste: ${TX_SIZE:-640x360} @ ${TX_FPS:-15} fps, ${TX_BITRATE:-800k}"
  echo "- Resultado: **$(( ${#RESULTS[@]} - FAILS ))/${#RESULTS[@]} critérios aprovados**"
  echo
  echo "| # | Critério | Resultado | Evidência |"
  echo "|---|---|---|---|"
  printf '%s\n' "${SORTED[@]}"
  echo
  echo "## Câmeras ao final"
  echo
  echo "| Cliente | Câmera | Estado | Vídeo | kbps | Gravação habilitada |"
  echo "|---|---|---|---|---|---|"
  echo "$CAMLIST"
  echo
  echo "## Eventos registrados durante o teste"
  echo
  echo "$EVENTS"
  echo
  echo "Saída completa dos testes automatizados: \`reports/phase1-${STAMP}-tests.log\`"
} > "$REPORT"

log "Relatório: $REPORT — $(( ${#RESULTS[@]} - FAILS ))/${#RESULTS[@]} aprovados"
[ "$FAILS" -eq 0 ]
