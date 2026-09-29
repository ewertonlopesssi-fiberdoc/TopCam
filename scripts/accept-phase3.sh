#!/usr/bin/env bash
# TopCam — teste de aceite da Fase 3 (ao vivo).
#
# Roda contra o ambiente Docker Compose real, pela porta do painel (gateway):
#   L1  5 câmeras da Empresa Alfa ao vivo com o transmissor de teste (CAM-001 com relógio);
#   L2–L5, L7  endereços temporários, HLS das 5 câmeras (ffprobe), WHEP, segurança, atraso;
#   L6  câmeras só ao vivo não geram arquivos nem registros de gravação;
#   L8  portas internas do servidor de mídia não publicadas; 8189 (WebRTC) publicada;
#   L9  consumo de CPU/memória com as 5 câmeras sendo assistidas (informativo);
#   L10 lint e testes automatizados.
# A reprodução na tela (WebRTC e HLS), a latência de ponta a ponta e o corte do vídeo
# ao retirar a permissão são verificados no navegador pelo E2E (e2e/ao-vivo.spec.ts).
# Relatório em reports/phase3-<data>.md.
#
# Uso:  scripts/accept-phase3.sh [--no-build] [--skip-tests] [--keep-tx]
#   --keep-tx  deixa os 5 transmissores de teste no ar ao final (para ver no painel)

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
KEEP_TX=0
while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) BUILD=0; shift ;;
    --skip-tests) RUN_TESTS=0; shift ;;
    --keep-tx) KEEP_TX=1; shift ;;
    *) echo "opção desconhecida: $1" >&2; exit 2 ;;
  esac
done

[ -f .env ] || { echo "Arquivo .env não encontrado. Rode scripts/generate-env.sh primeiro." >&2; exit 2; }
grep -q '^MEDIA_GATEWAY_TOKEN=.\+' .env || { echo "MEDIA_GATEWAY_TOKEN ausente no .env. Rode: scripts/generate-env.sh --add-missing" >&2; exit 2; }
set -a; . ./.env; set +a

# shellcheck disable=SC2086
dc() { docker compose ${COMPOSE_ARGS:-} "$@"; }
sql() { dc exec -T postgres psql -U topcam_owner -d topcam -Atq -c "$1" 2>/dev/null; }
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
now_s() { date +%s; }

mkdir -p reports
STAMP=$(date +%Y%m%d-%H%M%S)
REPORT="reports/phase3-${STAMP}.md"
RUN=$(date +%H%M%S)
ACC_EMAIL="aceite3-${RUN}@topcam.local"
ACC_PASSWORD="AceiteFase3-${RUN}-$(openssl rand -hex 4)"
RESULTS=()
FAILS=0
TENANT=empresa-alfa
CAMS=(CAM-001 CAM-002 CAM-003 CAM-004 CAM-005)

record() {
  RESULTS+=("| $1 | $3 | $([ "$2" = PASS ] && echo '✅ PASSOU' || echo '❌ FALHOU') | $4 |")
  [ "$2" = PASS ] || FAILS=$((FAILS + 1))
  log "$1 $2 — $4"
}

stage() {
  local name="$1"; shift
  local envs=(-e "BASE=http://gateway" -e "RUN=$RUN" -e "ACC_EMAIL=$ACC_EMAIL" -e "ACC_PASSWORD=$ACC_PASSWORD" -e "PUBLIC_HOST=${PUBLIC_HOST:-localhost}")
  for kv in "$@"; do envs+=(-e "$kv"); done
  dc exec -T "${envs[@]}" api node --input-type=module - "$name" < scripts/accept-phase3.mjs
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
  dc --profile test build tests >/dev/null 2>&1 || { echo "falha ao construir a imagem de testes" >&2; exit 1; }
else
  dc up -d --wait >/dev/null 2>&1 || { dc ps; echo "falha ao subir o ambiente" >&2; exit 1; }
fi

ACC_TEMP=$(dc exec -T api node apps/api/dist/cli.js user:create --email "$ACC_EMAIL" \
  --name "Aceite Fase 3" --role platform_admin --raw 2>&1 | tail -n1)
[[ "$ACC_TEMP" =~ ^[A-Za-z0-9]{14}$ ]] || { echo "falha ao criar usuário de aceite: $ACC_TEMP" >&2; exit 1; }

cleanup() {
  log "limpeza"
  stage clean "VIEWER_ID=${OUT_VIEWER_ID:-}" >/dev/null 2>&1
  dc exec -T api node apps/api/dist/cli.js user:delete --email "$ACC_EMAIL" >/dev/null 2>&1
  if [ "$KEEP_TX" = 0 ]; then
    for c in "${CAMS[@]}"; do docker rm -f "topcam-tx3-$c" >/dev/null 2>&1; done
  else
    log "transmissores de teste continuam no ar (docker rm -f topcam-tx3-CAM-00N para parar)"
  fi
}
trap cleanup EXIT

# ------------------------------------------------------------------ L1: 5 câmeras ao vivo
log "L1: iniciando 5 transmissores de teste (CAM-001 com relógio no vídeo)"
for c in "${CAMS[@]}"; do
  key=$(dc exec -T api node apps/api/dist/cli.js camera:show-key --tenant "$TENANT" --code "$c" --raw 2>/dev/null | tr -d '\r\n')
  docker rm -f "topcam-tx3-$c" >/dev/null 2>&1
  clock=0; [ "$c" = CAM-001 ] && clock=1
  TX_CLOCK=$clock dc --profile test run -d --rm --name "topcam-tx3-$c" test-transmitter publish "$key" "$c" >/dev/null 2>&1
done
t0=$(now_s)
while :; do
  n=$(sql "SELECT count(*) FROM cameras c JOIN tenants t ON t.id = c.tenant_id WHERE t.slug = '$TENANT' AND c.code IN ('CAM-001','CAM-002','CAM-003','CAM-004','CAM-005') AND c.status IN ('ao_vivo','gravando')")
  [ "${n:-0}" -ge 5 ] && break
  [ $(( $(now_s) - t0 )) -ge 60 ] && break
  sleep 2
done
states=$(sql "SELECT string_agg(c.code || '=' || c.status, ', ' ORDER BY c.code) FROM cameras c JOIN tenants t ON t.id = c.tenant_id WHERE t.slug = '$TENANT' AND c.code LIKE 'CAM-00%'")
record L1 "$([ "${n:-0}" -ge 5 ] && echo PASS || echo FAIL)" "5 câmeras recebidas por RTMP e ao vivo" "$states (em $(( $(now_s) - t0 )) s)"

# ------------------------------------------------------------------ L2–L5, L7
log "L2–L7: endereços, HLS, WHEP e segurança"
collect < <(stage setup "ACC_TEMP=$ACC_TEMP" 2>&1)

# ------------------------------------------------------------------ L6: nada gravado
# Câmeras só ao vivo (gravação desmarcada): nenhum arquivo e nenhum registro. As
# câmeras com gravação marcada (a partir da Fase 4) não entram nesta conta.
live_only=$(sql "SELECT string_agg(id::text, ' ') FROM cameras WHERE NOT recording_enabled AND deleted_at IS NULL")
files=0
for id in $live_only; do
  n=$(dc exec -T mediamtx sh -c "find /recordings/cam/$id -type f 2>/dev/null | wc -l" | tr -d '\r ')
  files=$((files + ${n:-0}))
done
segs=$(sql "SELECT count(*) FROM recording_segments s JOIN cameras c ON c.id = s.camera_id WHERE NOT c.recording_enabled AND s.state <> 'deleted'")
record L6 "$([ "$files" = 0 ] && [ "$segs" = 0 ] && echo PASS || echo FAIL)" \
  "Câmeras só ao vivo não gravam: nenhum arquivo nem registro de segmento" "câmeras só ao vivo: $(wc -w <<<"$live_only"); arquivos: $files; registros: $segs"

# ------------------------------------------------------------------ L8: portas
closed=(); open_int=()
for p in 8888 8889 9997 9998 8554; do
  if dc port mediamtx "$p" >/dev/null 2>&1; then open_int+=("$p"); else closed+=("$p"); fi
done
udp=$(dc port --protocol udp mediamtx 8189 2>/dev/null)
record L8 "$([ ${#open_int[@]} -eq 0 ] && [ -n "$udp" ] && echo PASS || echo FAIL)" \
  "Portas internas do servidor de mídia fechadas; 8189/UDP publicada para o WebRTC" \
  "não publicadas: ${closed[*]:-nenhuma}; publicadas indevidamente: ${open_int[*]:-nenhuma}; 8189/udp → ${udp:-não publicada}"

# ------------------------------------------------------------------ L9: consumo
stats=$(docker stats --no-stream --format '{{.Name}} CPU {{.CPUPerc}} MEM {{.MemUsage}}' 2>/dev/null \
  | grep -E 'topcam-(mediamtx|gateway|api|worker)-1' | sed 's/topcam-//; s/-1 / /' | paste -sd ';' -)
record L9 PASS "Consumo com 5 câmeras recebidas e assistidas (informativo)" "${stats:-indisponível}"

# ------------------------------------------------------------------ L10: testes
TEST_LOG="reports/phase3-${STAMP}-testes.log"
if [ "$RUN_TESTS" = 1 ]; then
  log "L10: lint + testes unitários e de integração"
  dc --profile test run --rm -e NO_COLOR=1 tests sh -c "pnpm lint && pnpm test" >"$TEST_LOG" 2>&1; rc=$?
  summary=$(sed 's/\x1b\[[0-9;]*m//g' "$TEST_LOG" | grep -E "^\s+Tests\s" | tail -n1 | xargs)
  record L10 "$([ $rc -eq 0 ] && echo PASS || echo FAIL)" "Lint e testes automatizados" "${summary:-sem resumo} (log: $TEST_LOG)"
else
  record L10 FAIL "Lint e testes automatizados" "não executado (--skip-tests)"
fi

# ------------------------------------------------------------------ relatório
{
  echo "# Aceite da Fase 3 — $(date '+%d/%m/%Y %H:%M')"
  echo
  echo "Host: $(hostname) · versão: ${TOPCAM_VERSION:-?} · commit: $(git rev-parse --short HEAD 2>/dev/null || echo '?') · PUBLIC_HOST: ${PUBLIC_HOST:-?}"
  echo
  echo "| # | Critério | Resultado | Evidência |"
  echo "|---|---|---|---|"
  printf '%s\n' "${RESULTS[@]}"
  echo
  echo "**Total: $(( ${#RESULTS[@]} - FAILS ))/${#RESULTS[@]} aprovados.**"
  echo
  echo "Reprodução na tela, latência de ponta a ponta e corte do WebRTC ao retirar a permissão: E2E (e2e/ao-vivo.spec.ts) e conferência no navegador (docs/procedimento-teste-twg6608.md, item 5)."
} >"$REPORT"

echo
cat "$REPORT"
echo
log "relatório: $REPORT"
[ "$FAILS" -eq 0 ]
