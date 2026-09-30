#!/usr/bin/env bash
# TopCam — teste de aceite da Fase 2 (autenticação, multiempresa, permissões por câmera, cadastros).
#
# Roda contra o ambiente Docker Compose real, pela mesma porta do painel (gateway Caddy):
#   1. cria um Super Admin temporário de aceite pela CLI (nunca usa nem altera a sua senha);
#   2. executa P1–P10 pela API (login, 1º acesso, rate limit, refresh/logout, dois clientes
#      fictícios isolados, visualizador restrito, chaves, suspensão, auditoria);
#   3. P11: transmite com o transmissor de teste usando a chave devolvida pelo cadastro e confere
#      que a câmera fica "Ao vivo";
#   4. P12: testes automatizados (lint + unitários + integração);
#   5. limpa: exclui câmeras e usuários de aceite, cancela os clientes de aceite e exclui o usuário temporário.
# Relatório em reports/phase2-<data>.md.
#
# Uso:  scripts/accept-phase2.sh [--no-build] [--skip-tests]
# Variável COMPOSE_ARGS: argumentos extras para "docker compose".

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

[ -f .env ] || { echo "Arquivo .env não encontrado. Rode scripts/generate-env.sh primeiro." >&2; exit 2; }
grep -q '^JWT_SECRET=.\+' .env || { echo "JWT_SECRET ausente no .env. Rode: scripts/generate-env.sh --add-missing" >&2; exit 2; }
set -a; . ./.env; set +a

# shellcheck disable=SC2086
dc() { docker compose ${COMPOSE_ARGS:-} "$@"; }
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

mkdir -p reports
STAMP=$(date +%Y%m%d-%H%M%S)
REPORT="reports/phase2-${STAMP}.md"
RUN=$(date +%H%M%S)
ACC_EMAIL="aceite-${RUN}@topcam.local"
ACC_PASSWORD="AceiteFase2-${RUN}-$(openssl rand -hex 4)"
RESULTS=()
FAILS=0

record() { # record <id> <PASS|FAIL> <critério> <evidência>
  RESULTS+=("| $1 | $3 | $([ "$2" = PASS ] && echo '✅ PASSOU' || echo '❌ FALHOU') | $4 |")
  [ "$2" = PASS ] || FAILS=$((FAILS + 1))
  log "$1 $2 — $4"
}

# Executa uma etapa do accept-phase2.mjs dentro do contêiner da API (Node 22, rede interna).
stage() {
  local name="$1"; shift
  local envs=(-e "BASE=http://gateway:8080" -e "RUN=$RUN" -e "ACC_EMAIL=$ACC_EMAIL" -e "ACC_PASSWORD=$ACC_PASSWORD")
  for kv in "$@"; do envs+=(-e "$kv"); done
  dc exec -T "${envs[@]}" api node --input-type=module - "$name" < scripts/accept-phase2.mjs
}

collect() { # lê a saída de uma etapa: RESULT → relatório, OUT → variáveis, ERROR → falha
  local line id st crit ev
  while IFS= read -r line; do
    case "$line" in
      RESULT\|*)
        IFS='|' read -r _ id st crit ev <<<"$line"
        record "$id" "$st" "$crit" "$ev" ;;
      OUT\|*)
        IFS='|' read -r _ id ev <<<"$line"
        printf -v "OUT_$id" '%s' "$ev" ;;
      ERROR\|*)
        record "ERRO" FAIL "Execução do roteiro" "${line#ERROR|}" ;;
    esac
  done
}

# ------------------------------------------------------------------ ambiente
if [ "$BUILD" = 1 ]; then
  log "construindo e subindo o ambiente (pode levar alguns minutos na primeira vez)"
  dc up -d --build --wait >/dev/null 2>&1 || { dc ps; echo "falha ao subir o ambiente" >&2; exit 1; }
  dc --profile test build tests >/dev/null 2>&1 || { echo "falha ao construir a imagem de testes" >&2; exit 1; }
else
  dc up -d --wait >/dev/null 2>&1 || { dc ps; echo "falha ao subir o ambiente" >&2; exit 1; }
fi
log "ambiente no ar: $(dc ps --format '{{.Service}}' | tr '\n' ' ')"

log "criando usuário temporário de aceite ($ACC_EMAIL)"
ACC_TEMP=$(dc exec -T api node apps/api/dist/cli.js user:create --email "$ACC_EMAIL" \
  --name "Aceite Fase 2" --role platform_admin --raw 2>&1 | tail -n1)
[[ "$ACC_TEMP" =~ ^[A-Za-z0-9]{14}$ ]] || { echo "falha ao criar usuário de aceite: $ACC_TEMP" >&2; exit 1; }

cleanup() {
  log "limpeza: câmeras e clientes de aceite, usuário temporário"
  [ -n "${OUT_CAM_IDS:-}" ] && stage clean "CAM_IDS=$OUT_CAM_IDS" "TENANT_A=${OUT_TENANT_A:-}" "TENANT_B=${OUT_TENANT_B:-}" >/dev/null 2>&1
  docker rm -f "topcam-tx-aceite2" >/dev/null 2>&1
  dc exec -T api node apps/api/dist/cli.js user:delete --email "$ACC_EMAIL" >/dev/null 2>&1
}
trap cleanup EXIT

# ------------------------------------------------------------------ P1–P10
log "P1–P10: API pelo gateway"
collect < <(stage setup "ACC_TEMP=$ACC_TEMP" 2>&1)

# ------------------------------------------------------------------ P11: transmissão real
if [ -n "${OUT_CAM_KEY:-}" ]; then
  log "P11: transmitindo para a câmera criada pelo cadastro"
  dc --profile test run -d --rm --name topcam-tx-aceite2 test-transmitter publish "$OUT_CAM_KEY" aceite >/dev/null 2>&1
  collect < <(stage live "CAM_ID=$OUT_CAM_ID" 2>&1)
  docker rm -f topcam-tx-aceite2 >/dev/null 2>&1
else
  record P11 FAIL "Câmera cadastrada pelo painel fica Ao vivo" "cadastro não devolveu a chave (veja P5)"
fi

# ------------------------------------------------------------------ P12: testes automatizados
TEST_LOG="reports/phase2-${STAMP}-testes.log"
if [ "$RUN_TESTS" = 1 ]; then
  log "P12: lint + testes unitários e de integração (container tests)"
  dc --profile test run --rm -e NO_COLOR=1 tests sh -c "pnpm lint && pnpm test" >"$TEST_LOG" 2>&1; rc=$?
  summary=$(sed 's/\x1b\[[0-9;]*m//g' "$TEST_LOG" | grep -E "^\s+Tests\s" | tail -n1 | xargs)
  record P12 "$([ $rc -eq 0 ] && echo PASS || echo FAIL)" "Lint e testes automatizados" "${summary:-sem resumo} (log: $TEST_LOG)"
else
  record P12 FAIL "Lint e testes automatizados" "não executado (--skip-tests)"
fi

# ------------------------------------------------------------------ relatório
{
  echo "# Aceite da Fase 2 — $(date '+%d/%m/%Y %H:%M')"
  echo
  echo "Host: $(hostname) · versão: ${TOPCAM_VERSION:-?} · commit: $(git rev-parse --short HEAD 2>/dev/null || echo '?')"
  echo
  echo "| # | Critério | Resultado | Evidência |"
  echo "|---|---|---|---|"
  printf '%s\n' "${RESULTS[@]}"
  echo
  echo "**Total: $(( ${#RESULTS[@]} - FAILS ))/${#RESULTS[@]} aprovados.**"
  echo
  echo "Telas (1440/768/390 px): conferidas pelos testes E2E (Playwright) — veja README, seção \"Testes do painel\"."
} >"$REPORT"

echo
cat "$REPORT"
echo
log "relatório: $REPORT"
[ "$FAILS" -eq 0 ]
