#!/usr/bin/env bash
# TopCam — teste de aceite da Fase 4 (gravação e retenção).
#
# Usa a CAM-001 da Empresa Alfa (câmera de TESTE) como câmera gravada durante o
# aceite e as CAM-002..005 como só ao vivo, todas com o transmissor de teste.
# Ao final devolve a CAM-001 de teste ao estado anterior e apaga as gravações de
# teste. Câmeras reais (ex.: a TWG 6608) não são alteradas; aparecem só no R9.
#
#   R1  chave geral ligada; o servidor de mídia grava só as câmeras marcadas
#   R2  primeiro segmento conferido (SHA-256, ffprobe) → estado "gravando"
#   R3  segmentos contínuos de ~60 s, sem lacunas enquanto a transmissão segue
#   R4  câmeras só ao vivo: zero arquivos e zero registros
#   R5  queda de 30 s: câmera offline, lacuna registrada, volta a "gravando"
#   R6  reinício do servidor de mídia: gravação volta e o trecho interrompido é indexado
#   R7  API fora do ar no fim de um segmento: a varredura do worker indexa e confere
#   R8  retenção: vencidos apagados do disco e do índice; outras câmeras intactas
#   R9  câmeras reais gravando (informativo: horas disponíveis, espaço, lacunas)
#   R10 lint e testes automatizados
# Relatório em reports/phase4-<data>.md. Duração: ~15 min.
#
# Uso:  scripts/accept-phase4.sh [--no-build] [--skip-tests] [--skip-restart]
#   --skip-restart  pula o R6 (reinício do servidor de mídia), que interrompe por
#                   alguns segundos TODAS as câmeras, inclusive as reais gravando.
# Rodar sem depender da conexão SSH:
#   nohup scripts/accept-phase4.sh --no-build > /root/aceite4.log 2>&1 &

set -uo pipefail
cd "$(dirname "$0")/.."

# Um aceite por vez: todos usam as câmeras de teste da Empresa Alfa, os mesmos
# transmissores e o mesmo banco de testes. Dois ao mesmo tempo se atrapalham.
exec 9>/tmp/topcam-aceite.lock
if ! flock -n 9; then
  echo "Já existe um teste de aceite em execução nesta máquina. Aguarde terminar (ps aux | grep accept-phase)." >&2
  exit 3
fi

BUILD=1
RUN_TESTS=1
SKIP_RESTART=0
while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) BUILD=0; shift ;;
    --skip-tests) RUN_TESTS=0; shift ;;
    --skip-restart) SKIP_RESTART=1; shift ;;
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
REPORT="reports/phase4-${STAMP}.md"
RESULTS=()
FAILS=0
SKIPS=0
TENANT=empresa-alfa
CAMS=(CAM-001 CAM-002 CAM-003 CAM-004 CAM-005)

record() {
  RESULTS+=("| $1 | $3 | $([ "$2" = PASS ] && echo '✅ PASSOU' || echo '❌ FALHOU') | $4 |")
  [ "$2" = PASS ] || FAILS=$((FAILS + 1))
  log "$1 $2 — $4"
}
skip() { # skip <id> <critério> <motivo>
  RESULTS+=("| $1 | $2 | ⏭️ PULADO | $3 |")
  SKIPS=$((SKIPS + 1))
  log "$1 PULADO — $3"
}
pass_if() { [ "$1" = 1 ] && echo PASS || echo FAIL; }

# wait_until <timeout_s> <comando...>
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
verified_count() { sql "SELECT count(*) FROM recording_segments WHERE camera_id = '$1' AND state = 'verified'"; }
key_of() { dc exec -T api node apps/api/dist/cli.js camera:show-key --tenant "$TENANT" --code "$1" --raw 2>/dev/null | tr -d '\r\n'; }
start_tx() { docker rm -f "topcam-tx4-$1" >/dev/null 2>&1; dc --profile test run -d --rm --name "topcam-tx4-$1" test-transmitter publish "$(key_of "$1")" "$1" >/dev/null 2>&1; }
stop_tx() { docker rm -f "topcam-tx4-$1" >/dev/null 2>&1; }
reconcile() { sql "INSERT INTO durable_jobs (type, payload) VALUES ('mediamtx.reconcile', '{\"reason\":\"aceite4\"}')" >/dev/null; dc exec -T redis redis-cli publish topcam:jobs:wake 1 >/dev/null 2>&1; }

# ------------------------------------------------------------------ ambiente
if [ "$BUILD" = 1 ]; then
  log "construindo e subindo o ambiente"
  dc up -d --build --wait >/dev/null 2>&1 || { dc ps; echo "falha ao subir o ambiente" >&2; exit 1; }
  dc --profile test build tests >/dev/null 2>&1 || { echo "falha ao construir a imagem de testes" >&2; exit 1; }
else
  dc up -d --wait >/dev/null 2>&1 || { dc ps; echo "falha ao subir o ambiente" >&2; exit 1; }
fi

CAM1=$(cam_id CAM-001)
[ -n "$CAM1" ] || { echo "CAM-001 da Empresa Alfa não encontrada (seed de demonstração)" >&2; exit 1; }
PREV_REC=$(sql "SELECT recording_enabled FROM cameras WHERE id = '$CAM1'")
PREV_RET=$(sql "SELECT coalesce(retention_policy_id::text, '') FROM cameras WHERE id = '$CAM1'")
T_START=$(sql "SELECT now()")
OTHER_BEFORE=$(sql "SELECT count(*) FROM recording_segments WHERE camera_id <> '$CAM1' AND state <> 'deleted' AND started_at < '$T_START'")

CLEANED=0
cleanup() {
  [ "$CLEANED" = 1 ] && return
  CLEANED=1
  log "limpeza: transmissores, CAM-001 de teste volta ao estado anterior, gravações de teste apagadas"
  for c in "${CAMS[@]}"; do stop_tx "$c"; done
  sql "UPDATE cameras SET recording_enabled = '$PREV_REC'::boolean, retention_policy_id = NULLIF('$PREV_RET', '')::uuid WHERE id = '$CAM1'" >/dev/null
  sql "UPDATE recording_segments SET expires_at = now() - interval '1 second' WHERE camera_id = '$CAM1' AND state NOT IN ('deleting', 'deleted')" >/dev/null
  reconcile
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM
trap 'cleanup; exit 129' HUP   # conexão SSH caiu

# Transmissores de teste que tenham sobrado de uma execução interrompida.
for c in "${CAMS[@]}"; do stop_tx "$c"; done

REAL_CAMS=$(sql "SELECT string_agg(t.slug || '/' || c.code, ', ') FROM cameras c JOIN tenants t ON t.id = c.tenant_id
                  WHERE c.recording_enabled AND c.enabled AND c.deleted_at IS NULL AND c.id <> '$CAM1'")
if [ -n "$REAL_CAMS" ] && [ "$SKIP_RESTART" = 0 ]; then
  log "AVISO: câmeras gravando fora do teste: $REAL_CAMS."
  log "AVISO: o R6 reinicia o servidor de mídia e cria uma lacuna de alguns segundos nelas. Para evitar: --skip-restart"
fi

# ------------------------------------------------------------------ R1: quem grava
log "R1: ligando a gravação da CAM-001 de teste (24 h) e conferindo o servidor de mídia"
sql "UPDATE system_settings SET value = 'true' WHERE key = 'recording.globally_enabled'" >/dev/null
sql "UPDATE cameras SET recording_enabled = true,
       retention_policy_id = coalesce(retention_policy_id, (SELECT id FROM retention_policies WHERE tenant_id IS NULL AND retention_hours = 24 LIMIT 1))
     WHERE id = '$CAM1'" >/dev/null
reconcile
for c in "${CAMS[@]}"; do start_tx "$c"; done
T_TX=$(now_s)

rec_paths() {
  dc exec -T worker node -e '
    fetch("http://mediamtx:9997/v3/config/paths/list?itemsPerPage=1000").then((r) => r.json()).then((j) => {
      console.log(j.items.filter((p) => p.record).map((p) => p.name).join(" "));
    });' 2>/dev/null | tr -d '\r'
}
cam1_recording() { [[ "$(rec_paths)" == *"$CAM1"* ]]; }
wait_until 60 cam1_recording
RECS=$(rec_paths)
SHOULD=$(sql "SELECT string_agg('cam/' || id, ' ' ORDER BY id) FROM cameras WHERE recording_enabled AND enabled AND deleted_at IS NULL")
GOT=$(tr ' ' '\n' <<<"$RECS" | sort | paste -sd' ' -)
EXP=$(tr ' ' '\n' <<<"$SHOULD" | sort | paste -sd' ' -)
record R1 "$(pass_if "$([ -n "$GOT" ] && [ "$GOT" = "$EXP" ] && echo 1)")" \
  "Chave geral ligada; o servidor de mídia grava só as câmeras com gravação marcada" \
  "gravando no servidor: $(wc -w <<<"$GOT") caminho(s) = câmeras marcadas ($(wc -w <<<"$EXP")); CAM-001 de teste incluída: $([[ "$GOT" == *$CAM1* ]] && echo sim || echo não)"

# ------------------------------------------------------------------ R2: primeiro segmento
log "R2: aguardando o primeiro segmento conferido (até 3 min)"
is_recording() { [ "$(status_of "$CAM1")" = gravando ]; }
if wait_until 180 is_recording; then ok=1; else ok=0; fi
FIRST=$(sql "SELECT duration_ms || ' ms, ' || pg_size_pretty(size_bytes) || ', ' || video_codec || '/' || coalesce(audio_codec, '-') || ', sha256 ' || left(checksum_sha256, 12) || '…' FROM recording_segments WHERE camera_id = '$CAM1' AND state = 'verified' AND started_at >= '$T_START' ORDER BY started_at LIMIT 1")
record R2 "$(pass_if $ok)" "Primeiro segmento conferido (tamanho, SHA-256, ffprobe) e só então \"gravando\"" \
  "$(status_of "$CAM1") em $(( $(now_s) - T_TX )) s; 1º segmento: ${FIRST:-nenhum}"

# ------------------------------------------------------------------ R3: continuidade
# Janela limpa: só segmentos que começam depois que a câmera já está gravando.
log "R3: 3 min de gravação contínua"
T_R3=$(sql "SELECT now()")
sleep 200
CONT=$(sql "WITH s AS (SELECT started_at, ended_at, duration_ms, lag(ended_at) OVER (ORDER BY started_at) AS prev_end
                         FROM recording_segments WHERE camera_id = '$CAM1' AND state = 'verified' AND started_at >= '$T_R3')
            SELECT count(*) || '|' || coalesce(round(min(duration_ms) / 1000.0, 1), 0) || '|' || coalesce(round(max(duration_ms) / 1000.0, 1), 0)
                   || '|' || coalesce(round(max(extract(epoch FROM started_at - prev_end))::numeric, 2), 0) FROM s")
IFS='|' read -r n dmin dmax maxgap <<<"$CONT"
ok=$([ "${n:-0}" -ge 2 ] && awk "BEGIN{exit !($maxgap <= 3)}" && echo 1)
record R3 "$(pass_if "$ok")" "Segmentos contínuos de ~60 s, sem lacunas com a transmissão no ar" \
  "$n segmentos conferidos; duração ${dmin}–${dmax} s; maior intervalo entre segmentos: ${maxgap} s"

# ------------------------------------------------------------------ R4: só ao vivo
files=0
for c in CAM-002 CAM-003 CAM-004 CAM-005; do
  id=$(cam_id "$c")
  n=$(dc exec -T mediamtx sh -c "find /recordings/cam/$id -type f 2>/dev/null | wc -l" | tr -d '\r ')
  files=$((files + ${n:-0}))
done
rows=$(sql "SELECT count(*) FROM recording_segments s JOIN cameras c ON c.id = s.camera_id JOIN tenants t ON t.id = c.tenant_id WHERE t.slug = '$TENANT' AND c.code IN ('CAM-002','CAM-003','CAM-004','CAM-005')")
live=$(sql "SELECT count(*) FROM cameras c JOIN tenants t ON t.id = c.tenant_id WHERE t.slug = '$TENANT' AND c.code IN ('CAM-002','CAM-003','CAM-004','CAM-005') AND c.status = 'ao_vivo'")
record R4 "$(pass_if "$([ "$files" = 0 ] && [ "$rows" = 0 ] && [ "$live" = 4 ] && echo 1)")" \
  "Câmeras só ao vivo (CAM-002..005): zero arquivos e zero registros" "ao vivo: $live/4; arquivos: $files; registros: $rows"

# ------------------------------------------------------------------ R5: queda
log "R5: derrubando a CAM-001 por 30 s"
EV0=$(sql "SELECT coalesce(max(id), 0) FROM camera_events")
stop_tx CAM-001
sleep 30
start_tx CAM-001
has_gap() { [ "$(sql "SELECT count(*) FROM camera_events WHERE id > $EV0 AND camera_id = '$CAM1' AND type = 'recording_gap'")" -ge 1 ]; }
wait_until 150 has_gap
wait_until 150 is_recording
OFF=$(sql "SELECT count(*) FROM camera_events WHERE id > $EV0 AND camera_id = '$CAM1' AND type = 'stream_offline'")
GAP=$(sql "SELECT data->>'gap_seconds' FROM camera_events WHERE id > $EV0 AND camera_id = '$CAM1' AND type = 'recording_gap' ORDER BY id LIMIT 1")
ST=$(status_of "$CAM1")
record R5 "$(pass_if "$([ "${OFF:-0}" -ge 1 ] && [ -n "$GAP" ] && [ "$ST" = gravando ] && echo 1)")" \
  "Queda de 30 s: offline, lacuna registrada e volta a gravar" "evento offline: $OFF; lacuna: ${GAP:-nenhuma} s; estado: $ST"

# ------------------------------------------------------------------ R6: reinício do MediaMTX
if [ "$SKIP_RESTART" = 1 ]; then
  skip R6 "Reinício do servidor de mídia: a gravação volta e o trecho interrompido é indexado" "--skip-restart"
else
log "R6: reiniciando o servidor de mídia no meio de um segmento"
sleep 20
N0=$(verified_count "$CAM1")
T_R6=$(sql "SELECT now()")
dc restart mediamtx >/dev/null 2>&1
new_after_restart() { [ "$(sql "SELECT count(*) FROM recording_segments WHERE camera_id = '$CAM1' AND state = 'verified' AND started_at > '$T_R6'")" -ge 1 ]; }
wait_until 240 new_after_restart
AFTER=$(sql "SELECT count(*) FROM recording_segments WHERE camera_id = '$CAM1' AND state = 'verified' AND started_at > '$T_R6'")
# O trecho que estava sendo gravado na hora do reinício também tem de estar no índice e conferido.
cut_indexed() { [ "$(sql "SELECT count(*) FROM recording_segments WHERE camera_id = '$CAM1' AND state = 'writing' AND started_at < '$T_R6'")" = 0 ]; }
wait_until 200 cut_indexed
CUT=$(sql "SELECT state || ' ' || round(duration_ms / 1000.0, 1) || ' s' FROM recording_segments WHERE camera_id = '$CAM1' AND started_at < '$T_R6' ORDER BY started_at DESC LIMIT 1")
record R6 "$(pass_if "$([ "${AFTER:-0}" -ge 1 ] && [[ "$CUT" == verified* ]] && echo 1)")" \
  "Reinício do servidor de mídia: a gravação volta e o trecho interrompido é indexado" \
  "segmentos conferidos após o reinício: $AFTER; trecho interrompido: ${CUT:-não encontrado}"
fi

# ------------------------------------------------------------------ R7: API fora do ar
log "R7: API fora do ar por 80 s (um segmento termina sem aviso)"
T_R7=$(sql "SELECT now()")
dc stop api >/dev/null 2>&1
sleep 80
dc start api >/dev/null 2>&1
api_up() { dc exec -T api wget -q -O /dev/null http://127.0.0.1:3000/health; }
wait_until 60 api_up
API_UP=$(sql "SELECT now()")
# O segmento que terminou com a API fora do ar (e os que começaram nesse período)
# precisam aparecer no índice e conferidos, mesmo sem o aviso do servidor de mídia.
orphans() {
  local listed rows_ n=0
  listed=$(dc exec -T mediamtx sh -c "cd /recordings && find cam/$CAM1 -type f -mmin +2 2>/dev/null" | tr -d '\r')
  for f in $listed; do
    rows_=$(sql "SELECT count(*) FROM recording_segments WHERE path = '$f' AND state = 'verified'")
    [ "$rows_" = 1 ] || n=$((n + 1))
  done
  echo "$n"
}
outage_indexed() {
  [ "$(sql "SELECT count(*) FROM recording_segments WHERE camera_id = '$CAM1' AND state = 'writing'
             AND started_at < '$API_UP'::timestamptz - interval '10 s'")" = 0 ] &&
  [ "$(sql "SELECT count(*) FROM recording_segments WHERE camera_id = '$CAM1' AND state = 'verified'
             AND started_at < '$T_R7' AND ended_at > '$T_R7'")" -ge 1 ] &&
  [ "$(orphans)" = 0 ]
}
wait_until 360 outage_indexed
ORPH=$(orphans)
IDX=$(sql "SELECT count(*) FROM recording_segments WHERE camera_id = '$CAM1' AND state = 'verified' AND ended_at > '$T_R7' AND started_at < '$API_UP'")
PEND=$(sql "SELECT count(*) FROM recording_segments WHERE camera_id = '$CAM1' AND state = 'writing' AND started_at < '$API_UP'::timestamptz - interval '10 s'")
record R7 "$(pass_if "$([ "$ORPH" = 0 ] && [ "${IDX:-0}" -ge 1 ] && [ "$PEND" = 0 ] && echo 1)")" \
  "API fora do ar: a varredura do worker indexa e confere o que os avisos perderam" \
  "segmentos gravados com a API fora do ar, conferidos: $IDX; pendentes: $PEND; arquivos sem registro conferido: $ORPH"

# ------------------------------------------------------------------ R8: retenção
log "R8: retenção (vence tudo da CAM-001 de teste, menos os 2 últimos)"
KEEP=$(sql "SELECT string_agg(quote_literal(id::text), ',') FROM (SELECT id FROM recording_segments WHERE camera_id = '$CAM1' AND state = 'verified' ORDER BY started_at DESC LIMIT 2) x")
EXP_N=$(sql "UPDATE recording_segments SET expires_at = now() - interval '1 second' WHERE camera_id = '$CAM1' AND state IN ('verified','corrupt','missing') AND id::text NOT IN ($KEEP) RETURNING 1" | wc -l)
EXP_PATHS=$(sql "SELECT path FROM recording_segments WHERE camera_id = '$CAM1' AND expires_at < now() AND state <> 'deleted'")
expired_gone() { [ "$(sql "SELECT count(*) FROM recording_segments WHERE camera_id = '$CAM1' AND expires_at < now() AND state <> 'deleted'")" = 0 ]; }
wait_until 150 expired_gone
left=0
for f in $EXP_PATHS; do
  dc exec -T mediamtx test -e "/recordings/$f" && left=$((left + 1))
done
KEPT=$(sql "SELECT count(*) FROM recording_segments WHERE id::text IN ($KEEP) AND state = 'verified'")
OTHER_AFTER=$(sql "SELECT count(*) FROM recording_segments WHERE camera_id <> '$CAM1' AND state <> 'deleted' AND started_at < '$T_START'")
record R8 "$(pass_if "$([ "$left" = 0 ] && [ "$KEPT" = 2 ] && [ "$OTHER_AFTER" -ge "$OTHER_BEFORE" ] && echo 1)")" \
  "Retenção: vencidos apagados do disco e do índice; os demais e as outras câmeras intactos" \
  "vencidos: $EXP_N; arquivos que sobraram: $left; mantidos: $KEPT/2; outras câmeras: $OTHER_BEFORE antes, $OTHER_AFTER depois"

# ------------------------------------------------------------------ R9: câmeras reais
REAL=$(sql "SELECT string_agg(x.linha, '; ') FROM (
              SELECT t.slug || '/' || c.code || ' ' || c.status || ': ' ||
                     coalesce(round((extract(epoch FROM (max(s.ended_at) - min(s.started_at))) / 3600)::numeric, 1), 0) || ' h, ' ||
                     count(s.id) || ' segmentos, ' || pg_size_pretty(coalesce(sum(s.size_bytes), 0)::bigint) AS linha
                FROM cameras c JOIN tenants t ON t.id = c.tenant_id
                LEFT JOIN recording_segments s ON s.camera_id = c.id AND s.state = 'verified'
               WHERE c.recording_enabled AND c.id <> '$CAM1' AND c.deleted_at IS NULL
               GROUP BY t.slug, c.code, c.status) x")
record R9 PASS "Outras câmeras gravando (informativo)" "${REAL:-nenhuma}"

# ------------------------------------------------------------------ R10: testes
TEST_LOG="reports/phase4-${STAMP}-testes.log"
if [ "$RUN_TESTS" = 1 ]; then
  log "R10: lint + testes (a imagem de testes é reconstruída se o código mudou)"
  dc --profile test build tests >/dev/null 2>&1 || log "aviso: falha ao construir a imagem de testes"
  dc --profile test run --rm -e NO_COLOR=1 tests sh -c "pnpm lint && pnpm test" >"$TEST_LOG" 2>&1; rc=$?
  summary=$(sed 's/\x1b\[[0-9;]*m//g' "$TEST_LOG" | grep -E "^\s+Tests\s" | tail -n1 | xargs)
  record R10 "$([ $rc -eq 0 ] && echo PASS || echo FAIL)" "Lint e testes automatizados" "${summary:-sem resumo} (log: $TEST_LOG)"
else
  record R10 FAIL "Lint e testes automatizados" "não executado (--skip-tests)"
fi

{
  echo "# Aceite da Fase 4 — $(date '+%d/%m/%Y %H:%M')"
  echo
  echo "Host: $(hostname) · versão: ${TOPCAM_VERSION:-?} · commit: $(git rev-parse --short HEAD 2>/dev/null || echo '?')"
  echo
  echo "| # | Critério | Resultado | Evidência |"
  echo "|---|---|---|---|"
  printf '%s\n' "${RESULTS[@]}"
  echo
  echo "**Total: $(( ${#RESULTS[@]} - FAILS - SKIPS ))/$(( ${#RESULTS[@]} - SKIPS )) aprovados$([ "$SKIPS" -gt 0 ] && echo " ($SKIPS pulado)").**"
  echo
  echo "Retenção real de 24 h: acompanhar com \`docker compose exec api node apps/api/dist/cli.js recording:status\` (o mais antigo deve ficar em ~24 h e o espaço estável)."
} >"$REPORT"

echo
cat "$REPORT"
echo
log "relatório: $REPORT"
[ "$FAILS" -eq 0 ]
