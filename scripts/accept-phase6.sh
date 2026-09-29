#!/usr/bin/env bash
# TopCam — teste de aceite da Fase 6 (armazenamento e proteção de disco).
#
# Não enche o disco de verdade: cria um nó de armazenamento de TESTE ("aceite6"), com
# cota, onde fica só a CAM-001 da Empresa Alfa (de teste), gravando pelo transmissor
# de teste. Reduzir a cota desse nó simula o disco enchendo. A TWG 6608 e as demais
# câmeras reais continuam no nó normal e não são tocadas.
#
#   S1  vigia de disco: disco de vídeo medido (espaço confere com o df), latência de escrita
#   S2  limites: 70% atenção e 85% alto, com evento e alerta
#   S3  95%: limpeza de emergência apaga o mais antigo do nó (só a câmera de teste),
#       volta abaixo de 90%, com evento, alerta e auditoria
#   S4  nada apagável (idade mínima): a gravação para (bloqueio), com alerta crítico
#   S4b com a gravação parada, o ao vivo e o painel continuam
#   S5  liberado o espaço: gravação volta sozinha (novo segmento conferido)
#   S6  cota do cliente: só alerta
#   S7  telas Armazenamento e Servidores (API) e acesso negado ao usuário de cliente
#   S8  disco real: latência de escrita e alertas de disco lento em 24 h (informativo)
#   S9  buracos dentro de segmentos nas câmeras reais em 24 h (informativo)
#   S10 lint e testes automatizados
# Relatório em reports/phase6-<data>.md. Duração: ~15 min.
#
# Uso:  scripts/accept-phase6.sh [--no-build] [--skip-tests]
#   nohup scripts/accept-phase6.sh --no-build > /root/aceite6.log 2>&1 &

set -uo pipefail
cd "$(dirname "$0")/.."

# Um aceite por vez (todos usam as câmeras de teste e o mesmo banco de testes).
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
REPORT="reports/phase6-${STAMP}.md"
RUN=$(date +%H%M%S)
ACC_EMAIL="aceite6-${RUN}@topcam.local"
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
key_of() { dc exec -T api node apps/api/dist/cli.js camera:show-key --tenant "$TENANT" --code "$1" --raw 2>/dev/null | tr -d '\r\n'; }
start_tx() { docker rm -f topcam-tx6-CAM-001 >/dev/null 2>&1; TX_CLOCK=1 dc --profile test run -d --rm --name topcam-tx6-CAM-001 test-transmitter publish "$(key_of CAM-001)" CAM-001 >/dev/null 2>&1; }
stop_tx() { docker rm -f topcam-tx6-CAM-001 >/dev/null 2>&1; }
reconcile() { sql "INSERT INTO durable_jobs (type, payload) VALUES ('mediamtx.reconcile', '{\"reason\":\"aceite6\"}')" >/dev/null; dc exec -T redis redis-cli publish topcam:jobs:wake 1 >/dev/null 2>&1; }
setting() { sql "UPDATE system_settings SET value = '$2'::jsonb WHERE key = '$1'" >/dev/null; }

stage() {
  local name="$1"; shift
  local envs=(-e "BASE=http://gateway" -e "RUN=$RUN" -e "ACC_EMAIL=$ACC_EMAIL" -e "ACC_TEMP=$ACC_TEMP" -e "CAM1=$CAM1")
  for kv in "$@"; do envs+=(-e "$kv"); done
  dc exec -T "${envs[@]}" api node --input-type=module - "$name" < scripts/accept-phase6.mjs
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
[ -n "$CAM1" ] || { echo "CAM-001 da Empresa Alfa não encontrada (seed de demonstração)" >&2; exit 1; }
MAIN_NODE=$(sql "SELECT id FROM storage_nodes WHERE name = 'storage-01'")
PREV=$(sql "SELECT recording_enabled || '|' || coalesce(retention_policy_id::text, '') || '|' || coalesce(storage_node_id::text, '') FROM cameras WHERE id = '$CAM1'")
IFS='|' read -r PREV_REC PREV_RET PREV_NODE <<<"$PREV"
PREV_PURGE=$(sql "SELECT value FROM system_settings WHERE key = 'storage.emergency_purge'")
PREV_MINAGE=$(sql "SELECT value FROM system_settings WHERE key = 'storage.purge_min_age_minutes'")
ALFA=$(sql "SELECT id FROM tenants WHERE slug = '$TENANT'")
PREV_TQUOTA=$(sql "SELECT coalesce(storage_quota_bytes::text, '') FROM tenants WHERE id = '$ALFA'")
T_START=$(sql "SELECT now()")

ACC_TEMP=$(dc exec -T api node apps/api/dist/cli.js user:create --email "$ACC_EMAIL" \
  --name "Aceite Fase 6" --role platform_admin --raw 2>&1 | tail -n1 | tr -d '\r')
[[ "$ACC_TEMP" =~ ^[A-Za-z0-9]{14}$ ]] || { echo "falha ao criar usuário de aceite: $ACC_TEMP" >&2; exit 1; }

CLEANED=0
cleanup() {
  [ "$CLEANED" = 1 ] && return
  CLEANED=1
  log "limpeza: transmissor, nó de teste removido, CAM-001 e configurações restauradas, usuários de aceite"
  stop_tx
  stage clean "GESTOR_ID=${OUT_GESTOR_ID:-}" >/dev/null 2>&1
  dc exec -T api node apps/api/dist/cli.js user:delete --email "$ACC_EMAIL" >/dev/null 2>&1
  sql "UPDATE cameras SET recording_enabled = '$PREV_REC'::boolean, retention_policy_id = NULLIF('$PREV_RET', '')::uuid,
         storage_node_id = coalesce(NULLIF('$PREV_NODE', '')::uuid, '$MAIN_NODE') WHERE id = '$CAM1'" >/dev/null
  if [ -n "${TEST_NODE:-}" ]; then
    sql "UPDATE recording_segments SET storage_node_id = '$MAIN_NODE' WHERE storage_node_id = '$TEST_NODE'" >/dev/null
    sql "UPDATE alerts SET status = 'resolved', resolved_at = now(), storage_node_id = NULL WHERE storage_node_id = '$TEST_NODE'" >/dev/null
    sql "DELETE FROM storage_nodes WHERE id = '$TEST_NODE'" >/dev/null
  fi
  if [ "$PREV_REC" != t ]; then
    sql "UPDATE recording_segments SET expires_at = now() - interval '1 second' WHERE camera_id = '$CAM1' AND state NOT IN ('deleting', 'deleted')" >/dev/null
  fi
  setting storage.emergency_purge "${PREV_PURGE:-true}"
  setting storage.purge_min_age_minutes "${PREV_MINAGE:-60}"
  sql "UPDATE tenants SET storage_quota_bytes = NULLIF('$PREV_TQUOTA', '')::bigint WHERE id = '$ALFA'" >/dev/null
  reconcile
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM
trap 'cleanup; exit 129' HUP

stop_tx
# Nó de teste de uma execução interrompida.
sql "UPDATE recording_segments SET storage_node_id = '$MAIN_NODE' WHERE storage_node_id = (SELECT id FROM storage_nodes WHERE name = 'aceite6')" >/dev/null
sql "UPDATE alerts SET status = 'resolved', resolved_at = now(), storage_node_id = NULL WHERE storage_node_id = (SELECT id FROM storage_nodes WHERE name = 'aceite6')" >/dev/null
sql "UPDATE cameras SET storage_node_id = '$MAIN_NODE' WHERE storage_node_id = (SELECT id FROM storage_nodes WHERE name = 'aceite6')" >/dev/null
sql "DELETE FROM storage_nodes WHERE name = 'aceite6'" >/dev/null

node_field() { sql "SELECT $2 FROM storage_nodes WHERE id = '$1'"; }
seg_bytes() { sql "SELECT coalesce(sum(size_bytes), 0) FROM recording_segments WHERE storage_node_id = '$TEST_NODE' AND state <> 'deleted'"; }
set_quota_pct() { # set_quota_pct <pct alvo>: cota = gravado / pct
  local b; b=$(seg_bytes)
  sql "UPDATE storage_nodes SET quota_bytes = ($b::bigint * 100 / $1)::bigint WHERE id = '$TEST_NODE'" >/dev/null
}
fresh() { [ "$(sql "SELECT (last_seen_at > now() - interval '5 seconds')::int FROM storage_nodes WHERE id = '$1'")" = 1 ]; }
wait_check() { # espera o próximo ciclo do vigia (até 75 s)
  local t0; t0=$(now_s)
  sleep 5
  until fresh "$1"; do [ $(( $(now_s) - t0 )) -ge 75 ] && return 1; sleep 2; done
}

# ------------------------------------------------------------------ S1: vigia no disco real
log "S1: vigia do disco de vídeo"
wait_until 75 fresh "$MAIN_NODE"
S1=$(sql "SELECT status || '|' || used_pct || '|' || (free_bytes / 1000000000.0)::numeric(10,1) || '|' || coalesce(write_latency_ms::text, '-') || '|' || (last_seen_at > now() - interval '90 seconds')::int FROM storage_nodes WHERE id = '$MAIN_NODE'")
IFS='|' read -r s1_status s1_pct s1_free s1_lat s1_recent <<<"$S1"
DF_FREE=$(dc exec -T mediamtx sh -c "df -B1 /recordings | tail -1" | awk '{printf "%.1f", $4/1e9}')
ok=$(awk -v a="${s1_free:-0}" -v b="${DF_FREE:-0}" 'BEGIN{d=a-b; if(d<0)d=-d; print (b>0 && d/b<0.05)?1:0}')
record S1 "$(pass_if "$([ "$s1_recent" = 1 ] && [ "$ok" = 1 ] && [ "$s1_lat" != - ] && echo 1)")" \
  "Vigia mede o disco de vídeo (confere com o df) e a latência de escrita" \
  "storage-01: ${s1_status}, ${s1_pct}% usado, livre ${s1_free} GB (df: ${DF_FREE} GB), escrita ${s1_lat} ms"

# ------------------------------------------------------------------ preparação: nó de teste + gravação
log "preparação: nó de teste 'aceite6' com a CAM-001 de teste gravando"
TEST_NODE=$(sql "INSERT INTO storage_nodes (name, mount_path, status, quota_bytes) VALUES ('aceite6', '/recordings', 'ok', 100000000000) RETURNING id")
setting storage.emergency_purge true
setting storage.purge_min_age_minutes 0
sql "UPDATE cameras SET storage_node_id = '$TEST_NODE', recording_enabled = true,
       retention_policy_id = coalesce(retention_policy_id, (SELECT id FROM retention_policies WHERE tenant_id IS NULL AND retention_hours = 24 LIMIT 1))
     WHERE id = '$CAM1'" >/dev/null
reconcile
start_tx
enough() { [ "$(sql "SELECT count(*) FROM recording_segments WHERE storage_node_id = '$TEST_NODE' AND state = 'verified'")" -ge 4 ]; }
wait_until 330 enough || log "aviso: menos de 4 segmentos conferidos no nó de teste"
stop_tx   # volume fixo durante os limites
sleep 15
SEGS0=$(sql "SELECT count(*) FROM recording_segments WHERE storage_node_id = '$TEST_NODE' AND state = 'verified'")
log "nó de teste com $SEGS0 segmentos, $(( $(seg_bytes) / 1000000 )) MB"

# ------------------------------------------------------------------ S2: 70% e 85%
log "S2: limites de atenção e alto"
EV0=$(sql "SELECT coalesce(max(id), 0) FROM camera_events")
set_quota_pct 76; wait_check "$TEST_NODE"; wait_check "$TEST_NODE"
L1=$(node_field "$TEST_NODE" "status || ' ' || used_pct || '%'")
A1=$(sql "SELECT severity FROM alerts WHERE dedup_key = 'storage_level:$TEST_NODE' AND status <> 'resolved'")
set_quota_pct 88; wait_check "$TEST_NODE"; wait_check "$TEST_NODE"
L2=$(node_field "$TEST_NODE" "status || ' ' || used_pct || '%'")
A2=$(sql "SELECT severity FROM alerts WHERE dedup_key = 'storage_level:$TEST_NODE' AND status <> 'resolved'")
EVS=$(sql "SELECT string_agg(data->>'to', ',' ORDER BY id) FROM camera_events WHERE id > $EV0 AND type = 'storage_level' AND data->>'node' = 'aceite6'")
record S2 "$(pass_if "$([[ "$L1" == warning* ]] && [ "$A1" = warning ] && [[ "$L2" == high* ]] && [ "$A2" = error ] && [[ "$EVS" == *warning*high* ]] && echo 1)")" \
  "70% atenção e 85% alto, com evento na mudança e alerta (um só, atualizado)" \
  "76% → ${L1} (alerta ${A1:-nenhum}); 88% → ${L2} (alerta ${A2:-nenhum}); eventos: ${EVS:-nenhum}"

# ------------------------------------------------------------------ S3: 95% → limpeza de emergência
log "S3: 95% — limpeza de emergência"
EV1=$(sql "SELECT coalesce(max(id), 0) FROM camera_events")
OLDEST=$(sql "SELECT path FROM recording_segments WHERE storage_node_id = '$TEST_NODE' AND state = 'verified' ORDER BY started_at LIMIT 1")
NEWEST=$(sql "SELECT path FROM recording_segments WHERE storage_node_id = '$TEST_NODE' AND state = 'verified' ORDER BY started_at DESC LIMIT 1")
set_quota_pct 97
purged() { [ "$(sql "SELECT count(*) FROM camera_events WHERE id > $EV1 AND type = 'storage_purge'")" -ge 1 ]; }
wait_until 90 purged
wait_check "$TEST_NODE"
PURGE=$(sql "SELECT (data->>'segments') || '|' || (data->>'node') || '|' || (data->'cameras')::text || '|' || round((data->>'bytes')::numeric / 1e6, 1) FROM camera_events WHERE id > $EV1 AND type = 'storage_purge' ORDER BY id LIMIT 1")
IFS='|' read -r p_segs p_node p_cams p_mb <<<"$PURGE"
OLD_GONE=$(dc exec -T mediamtx sh -c "[ -e /recordings/$OLDEST ] && echo existe || echo apagado" | tr -d '\r')
NEW_KEPT=$(dc exec -T mediamtx sh -c "[ -e /recordings/$NEWEST ] && echo existe || echo apagado" | tr -d '\r')
L3=$(node_field "$TEST_NODE" "status || ' ' || used_pct")
PCT3=$(awk '{print $2}' <<<"$L3")
AUD=$(sql "SELECT count(*) FROM audit_logs WHERE action = 'storage.emergency_purge' AND entity_id = '$TEST_NODE'")
PALERT=$(sql "SELECT severity FROM alerts WHERE dedup_key = 'storage_purge:$TEST_NODE' AND status <> 'resolved'")
OTHER=$(sql "SELECT count(*) FROM camera_events WHERE id > $EV1 AND type = 'storage_purge' AND data->>'node' <> 'aceite6'")
ok=$([ -n "$p_segs" ] && [ "$p_node" = aceite6 ] && [ "$p_cams" = '{"CAM-001": '"$p_segs"'}' ] && [ "$OLD_GONE" = apagado ] && [ "$NEW_KEPT" = existe ] \
     && awk -v p="${PCT3:-100}" 'BEGIN{exit !(p < 95)}' && [ "$AUD" -ge 1 ] && [ "$PALERT" = warning ] && [ "$OTHER" = 0 ] && echo 1)
record S3 "$(pass_if "$ok")" \
  "95%: apaga o mais antigo do nó (mesmo dentro da retenção), volta abaixo do crítico; evento, alerta e auditoria; outros discos intocados" \
  "${p_segs:-0} segmento(s), ${p_mb:-0} MB, câmeras ${p_cams:-?}; mais antigo: ${OLD_GONE}; mais novo: ${NEW_KEPT}; depois: ${L3}%; alerta ${PALERT:-nenhum}; auditoria ${AUD}; limpeza em outros discos: ${OTHER}"

# ------------------------------------------------------------------ S4: nada apagável → gravação para
log "S4: nada apagável (idade mínima 24 h) — a gravação deve parar"
start_tx
is_recording() { [ "$(sql "SELECT status FROM cameras WHERE id = '$CAM1'")" = gravando ]; }
wait_until 240 is_recording || log "aviso: CAM-001 não voltou a gravar antes do S4"
setting storage.purge_min_age_minutes 1440
EV2=$(sql "SELECT coalesce(max(id), 0) FROM camera_events")
set_quota_pct 97
blocked() { [ "$(node_field "$TEST_NODE" recording_blocked)" = t ]; }
wait_until 90 blocked
rec_flag() {
  dc exec -T worker node -e "
    fetch('http://mediamtx:9997/v3/config/paths/get/cam/$CAM1').then((r) => r.json()).then((j) => console.log(String(j.record)));" 2>/dev/null | tr -d '\r'
}
not_rec() { [ "$(rec_flag)" = false ]; }
wait_until 60 not_rec
not_gravando() { [ "$(sql "SELECT status FROM cameras WHERE id = '$CAM1'")" != gravando ]; }
wait_until 150 not_gravando
B_ALERT=$(sql "SELECT severity FROM alerts WHERE dedup_key = 'storage_blocked:$TEST_NODE' AND status <> 'resolved'")
B_EV=$(sql "SELECT count(*) FROM camera_events WHERE id > $EV2 AND type = 'storage_recording_blocked'")
P_EV=$(sql "SELECT count(*) FROM camera_events WHERE id > $EV2 AND type = 'storage_purge'")
CSTAT=$(sql "SELECT status FROM cameras WHERE id = '$CAM1'")
record S4 "$(pass_if "$(blocked && [ "$(rec_flag)" = false ] && [ "$B_ALERT" = critical ] && [ "$B_EV" -ge 1 ] && [ "$P_EV" = 0 ] && [ "$CSTAT" != gravando ] && echo 1)")" \
  "Sem gravação apagável (mais nova que a idade mínima): a gravação do disco para, com alerta crítico" \
  "bloqueado: $(node_field "$TEST_NODE" recording_blocked); gravação no servidor de mídia: $(rec_flag); câmera: ${CSTAT}; alerta ${B_ALERT:-nenhum}; limpezas: ${P_EV}"
collect < <(stage live 2>&1)

# ------------------------------------------------------------------ S5: espaço liberado → volta
log "S5: espaço liberado — a gravação deve voltar sozinha"
# Libera com uma cota folgada (sem cota valeria o disco físico, que pode estar cheio por outros motivos).
sql "UPDATE storage_nodes SET quota_bytes = 100000000000 WHERE id = '$TEST_NODE'" >/dev/null
T_RES=$(sql "SELECT now()")
unblocked() { [ "$(node_field "$TEST_NODE" recording_blocked)" = f ]; }
wait_until 90 unblocked
new_seg() { [ "$(sql "SELECT count(*) FROM recording_segments WHERE camera_id = '$CAM1' AND state = 'verified' AND started_at > '$T_RES'")" -ge 1 ]; }
wait_until 240 new_seg
wait_until 60 is_recording
R_EV=$(sql "SELECT count(*) FROM camera_events WHERE id > $EV2 AND type = 'storage_recording_resumed'")
B_OPEN=$(sql "SELECT count(*) FROM alerts WHERE dedup_key = 'storage_blocked:$TEST_NODE' AND status <> 'resolved'")
record S5 "$(pass_if "$(unblocked && new_seg && [ "$R_EV" -ge 1 ] && [ "$B_OPEN" = 0 ] && echo 1)")" \
  "Com espaço, a gravação volta sozinha e o alerta crítico se fecha" \
  "bloqueado: $(node_field "$TEST_NODE" recording_blocked); gravação: $(rec_flag); câmera: $(sql "SELECT status FROM cameras WHERE id = '$CAM1'"); segmento novo conferido: $(new_seg && echo sim || echo não); alerta aberto: ${B_OPEN}"
stop_tx

# ------------------------------------------------------------------ S6: cota do cliente
log "S6: cota do cliente (só alerta)"
USED=$(sql "SELECT coalesce(sum(size_bytes), 0) FROM recording_segments WHERE tenant_id = '$ALFA' AND state <> 'deleted'")
SEGS_BEFORE=$(sql "SELECT count(*) FROM recording_segments WHERE tenant_id = '$ALFA' AND state <> 'deleted'")
sql "UPDATE tenants SET storage_quota_bytes = ($USED::bigint * 100 / 95)::bigint WHERE id = '$ALFA'" >/dev/null
talert() { [ -n "$(sql "SELECT severity FROM alerts WHERE dedup_key = 'tenant_quota:$ALFA' AND status <> 'resolved'")" ]; }
wait_until 75 talert
TA=$(sql "SELECT severity || ' — ' || title FROM alerts WHERE dedup_key = 'tenant_quota:$ALFA' AND status <> 'resolved'")
SEGS_AFTER=$(sql "SELECT count(*) FROM recording_segments WHERE tenant_id = '$ALFA' AND state <> 'deleted'")
record S6 "$(pass_if "$([[ "$TA" == warning* ]] && [ "$SEGS_AFTER" -ge "$SEGS_BEFORE" ] && echo 1)")" \
  "Cota do cliente: só alerta (nada é apagado nem parado)" \
  "${TA:-sem alerta}; segmentos do cliente antes/depois: ${SEGS_BEFORE}/${SEGS_AFTER}"
sql "UPDATE tenants SET storage_quota_bytes = NULLIF('$PREV_TQUOTA', '')::bigint WHERE id = '$ALFA'" >/dev/null

# ------------------------------------------------------------------ S7: API e telas
collect < <(stage api 2>&1)

# ------------------------------------------------------------------ S8, S9: disco real (informativo)
S8=$(sql "SELECT 'escrita agora ' || coalesce(write_latency_ms::text, '?') || ' ms; máxima em 24 h ' ||
                 coalesce((SELECT max(write_latency_ms)::text FROM storage_samples WHERE storage_node_id = n.id AND sampled_at > now() - interval '24 hours'), '?') || ' ms; ' ||
                 (SELECT count(*) FROM camera_events WHERE type = 'storage_slow' AND occurred_at > now() - interval '24 hours') || ' alerta(s) de disco lento em 24 h'
            FROM storage_nodes n WHERE id = '$MAIN_NODE'")
record S8 PASS "Disco de vídeo real: latência de escrita (informativo)" "${S8:-sem leitura}"
S9=$(sql "SELECT coalesce(string_agg(t.slug || '/' || c.code || ': ' || x.n || ' buraco(s), ' || x.s || ' s', '; '), 'nenhum')
            FROM (SELECT camera_id, count(*) n, round(sum((data->>'gap_seconds')::numeric), 1) s FROM camera_events
                   WHERE type = 'recording_gap' AND data->>'kind' = 'internal' AND occurred_at > now() - interval '24 hours'
                     AND camera_id <> '$CAM1'
                   GROUP BY camera_id) x
            JOIN cameras c ON c.id = x.camera_id JOIN tenants t ON t.id = c.tenant_id")
record S9 PASS "Quadros perdidos dentro de segmentos nas câmeras reais em 24 h (informativo)" "$S9"

# ------------------------------------------------------------------ S10: testes
TEST_LOG="reports/phase6-${STAMP}-testes.log"
if [ "$RUN_TESTS" = 1 ]; then
  log "S10: lint + testes (a imagem de testes é reconstruída se o código mudou)"
  dc --profile test build tests >/dev/null 2>&1 || log "aviso: falha ao construir a imagem de testes"
  dc --profile test run --rm -e NO_COLOR=1 tests sh -c "pnpm lint && pnpm test" >"$TEST_LOG" 2>&1; rc=$?
  summary=$(sed 's/\x1b\[[0-9;]*m//g' "$TEST_LOG" | grep -E "^\s+Tests\s" | tail -n1 | xargs)
  record S10 "$([ $rc -eq 0 ] && echo PASS || echo FAIL)" "Lint e testes automatizados" "${summary:-sem resumo} (log: $TEST_LOG)"
else
  record S10 FAIL "Lint e testes automatizados" "não executado (--skip-tests)"
fi

# ------------------------------------------------------------------ relatório
{
  echo "# Aceite da Fase 6 — $(date '+%d/%m/%Y %H:%M')"
  echo
  echo "Host: $(hostname) · versão: ${TOPCAM_VERSION:-?} · commit: $(git rev-parse --short HEAD 2>/dev/null || echo '?')"
  echo
  echo "| # | Critério | Resultado | Evidência |"
  echo "|---|---|---|---|"
  printf '%s\n' "${RESULTS[@]}"
  echo
  echo "**Total: $(( ${#RESULTS[@]} - FAILS ))/${#RESULTS[@]} aprovados.**"
  echo
  echo "Telas (Armazenamento e Servidores): E2E e2e/armazenamento.spec.ts."
} >"$REPORT"

echo
cat "$REPORT"
echo
log "relatório: $REPORT"
[ "$FAILS" -eq 0 ]
