#!/usr/bin/env bash
# TopCam — relatório do teste contínuo (Fase 8). Só lê; não altera nada.
#
#   scripts/report-7days.sh                          # últimos 7 dias
#   scripts/report-7days.sh --since "2026-10-01 10:00"   # desde o início do teste
#   scripts/report-7days.sh --days 3                 # prévia parcial
#
# Fontes: disponibilidade por hora (câmeras), índice das gravações (inclui os apagados
# pela retenção, guardados 30 dias), alertas, eventos, backups, amostras do disco de vídeo
# (7 dias) e o Prometheus (CPU, memória, disco do sistema, travamentos de E/S; 7 dias).
# Gere no fim do período: amostras e métricas com mais de 7 dias são descartadas.
# Relatório em reports/relatorio-continuo-<data>.md.
set -uo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC2086
dc() { docker compose ${COMPOSE_ARGS:-} "$@"; }
sql() { dc exec -T postgres psql -U topcam_owner -d topcam -Atq -F '|' -c "$1" </dev/null 2>/dev/null | tr -d '\r'; }

DAYS=7 SINCE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --days) DAYS="$2"; shift 2 ;;
    --since) SINCE="$2"; shift 2 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "opção desconhecida: $1" >&2; exit 2 ;;
  esac
done
[ -f .env ] && { set -a; . ./.env; set +a; }
if [ -n "$SINCE" ]; then
  FROM=$(sql "SELECT ('$SINCE'::timestamp AT TIME ZONE 'America/Sao_Paulo')") || true
  [ -n "$FROM" ] || { echo "data inválida: $SINCE (use \"AAAA-MM-DD HH:MM\")" >&2; exit 2; }
else
  FROM=$(sql "SELECT now() - interval '$DAYS days'")
fi
TO=$(sql "SELECT now()")
HOURS=$(sql "SELECT round(extract(epoch FROM '$TO'::timestamptz - '$FROM'::timestamptz) / 3600, 1)")
SECS=$(sql "SELECT extract(epoch FROM '$TO'::timestamptz - '$FROM'::timestamptz)::bigint")
BR="AT TIME ZONE 'America/Sao_Paulo'"
fmt() { sql "SELECT to_char('$1'::timestamptz $BR, 'DD/MM/YYYY HH24:MI')"; }

mkdir -p reports
OUT="reports/relatorio-continuo-$(date +%Y%m%d-%H%M).md"
ATTN=()

# Prometheus pelo worker (rede interna). Devolve o número ou "-".
prom() {
  dc exec -T -e Q="$1" worker node -e '
    fetch("http://prometheus:9090/api/v1/query?query=" + encodeURIComponent(process.env.Q))
      .then((r) => r.json())
      .then((j) => { const v = j?.data?.result?.[0]?.value?.[1]; console.log(v === undefined ? "-" : Number(v).toFixed(2)); })
      .catch(() => console.log("-"));' </dev/null 2>/dev/null | tr -d '\r'
}
PR="${SECS}s"
[ "$SECS" -gt 604800 ] && PR="7d"

{
echo "# TopCam — relatório do teste contínuo"
echo
echo "Período: **$(fmt "$FROM") a $(fmt "$TO")** (horário de Brasília, $HOURS h) · host $(hostname) · commit $(git rev-parse --short HEAD 2>/dev/null || echo '?')"
echo

# ------------------------------------------------------------------ serviços
echo "## Serviços"
echo
RESTARTED=""
FROM_EPOCH=$(sql "SELECT extract(epoch FROM '$FROM'::timestamptz)::bigint")
echo "| Serviço | Estado | No ar desde | Reinícios automáticos |"
echo "|---|---|---|---|"
# "motion" (eventos e detector de movimento) só existe a partir da versão com detecção de movimento.
EXTRA=$(dc config --services 2>/dev/null | grep -x motion || true)
for s in postgres redis api worker $EXTRA backup web gateway mediamtx prometheus node-exporter; do
  id=$(dc ps -q "$s" 2>/dev/null)
  if [ -z "$id" ]; then echo "| $s | ausente | — | — |"; ATTN+=("serviço $s ausente"); continue; fi
  read -r st hl started rc <<<"$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}} {{.State.StartedAt}} {{.RestartCount}}' "$id")"
  since=$(date -d "$started" '+%d/%m %H:%M' 2>/dev/null || echo "$started")
  echo "| $s | $st${hl:+/$hl} | $since | $rc |"
  [ "$rc" -gt 0 ] && ATTN+=("$s reiniciou sozinho $rc vez(es)")
  [ "$(date -d "$started" +%s 2>/dev/null || echo 0)" -gt "$FROM_EPOCH" ] && RESTARTED+="$s ($since), "
done
[ -n "$RESTARTED" ] && ATTN+=("contêineres (re)iniciados durante o período: ${RESTARTED%, } — conferir se foi atualização, reinício da VM ou falha")
echo "Reinício da VM mais recente: $(date -d "@$(awk '/^btime/ {print $2}' /proc/stat)" '+%d/%m/%Y %H:%M')"
echo

# ------------------------------------------------------------------ câmeras
echo "## Câmeras — disponibilidade"
echo
echo "| Cliente | Câmera | Horas observadas | No ar | Gravando |"
echo "|---|---|---|---|---|"
sql "SELECT t.name, c.code || ' · ' || c.name, round(sum(h.observed_s) / 3600.0, 1),
            round(100.0 * sum(h.online_s) / nullif(sum(h.observed_s), 0), 2),
            CASE WHEN bool_or(c.recording_enabled) THEN round(100.0 * sum(h.recording_s) / nullif(sum(h.observed_s), 0), 2)::text || '%' ELSE '—' END
       FROM camera_hourly h JOIN cameras c ON c.id = h.camera_id JOIN tenants t ON t.id = c.tenant_id
      WHERE h.hour >= date_trunc('hour', '$FROM'::timestamptz) AND h.hour < '$TO' AND h.observed_s > 0
      GROUP BY t.name, c.code, c.name ORDER BY t.name, c.code" |
  while IFS='|' read -r tn cn obs on rec; do echo "| $tn | $cn | $obs | $on% | $rec |"; done
echo
LOWCAMS=$(sql "SELECT string_agg(x2.n, ', ') || CASE WHEN count(*) OVER () > 0 THEN '' END FROM (SELECT c.code || ' (' || t.name || ')' AS n FROM (
                 SELECT camera_id, 100.0 * sum(online_s) / nullif(sum(observed_s), 0) AS pct FROM camera_hourly
                  WHERE hour >= date_trunc('hour', '$FROM'::timestamptz) AND observed_s > 0 GROUP BY camera_id) x
                 JOIN cameras c ON c.id = x.camera_id JOIN tenants t ON t.id = c.tenant_id
                WHERE x.pct < 99 AND c.deleted_at IS NULL AND t.slug NOT IN ('empresa-alfa', 'condominio-sol')
                ORDER BY x.pct LIMIT 10) x2")
LOWN=$(sql "SELECT count(*) FROM (SELECT camera_id FROM camera_hourly WHERE hour >= date_trunc('hour', '$FROM'::timestamptz) AND observed_s > 0
              GROUP BY camera_id HAVING 100.0 * sum(online_s) / nullif(sum(observed_s), 0) < 99) x
              JOIN cameras c ON c.id = x.camera_id JOIN tenants t ON t.id = c.tenant_id
             WHERE c.deleted_at IS NULL AND t.slug NOT IN ('empresa-alfa', 'condominio-sol')")
[ "${LOWN:-0}" -gt 10 ] && LOWCAMS="$LOWCAMS e mais $(( LOWN - 10 ))"
[ -n "$LOWCAMS" ] && ATTN+=("câmeras com menos de 99% no ar: $LOWCAMS")

# ------------------------------------------------------------------ gravação
echo "## Gravação contínua"
echo
echo "Inclui os segmentos já apagados pela retenção (o índice os guarda por 30 dias). Nas câmeras com"
echo "gravação só com movimento, os trechos sem movimento também contam: foram gravados e apagados depois."
echo
echo "| Câmera | Segmentos | Gravado | Cobertura | Lacunas > 10 s | Maior lacuna | Corrompidos/faltando |"
echo "|---|---|---|---|---|---|---|"
sql "WITH s AS (
       SELECT camera_id, started_at, coalesce(ended_at, started_at + duration_ms * interval '1 ms') AS ended_at, duration_ms, state,
              lag(coalesce(ended_at, started_at + duration_ms * interval '1 ms')) OVER (PARTITION BY camera_id ORDER BY started_at) AS prev_end
         FROM recording_segments WHERE started_at >= '$FROM' AND started_at < '$TO')
     SELECT t.name || ' / ' || c.code, count(*),
            round(sum(coalesce(s.duration_ms, 0)) / 3600000.0, 1) || ' h',
            round(100.0 * sum(coalesce(s.duration_ms, 0)) / 1000 / $SECS, 2) || '%',
            count(*) FILTER (WHERE extract(epoch FROM s.started_at - s.prev_end) > 10),
            coalesce(round(max(extract(epoch FROM s.started_at - s.prev_end)))::text || ' s', '—'),
            count(*) FILTER (WHERE s.state IN ('corrupt', 'missing'))
       FROM s JOIN cameras c ON c.id = s.camera_id JOIN tenants t ON t.id = c.tenant_id
      GROUP BY t.name, c.code ORDER BY 1" |
  while IFS='|' read -r a b c d e f g; do echo "| $a | $b | $c | $d | $e | $f | $g |"; done
echo
echo "Maiores lacunas:"
echo
sql "WITH s AS (
       SELECT camera_id, started_at, lag(coalesce(ended_at, started_at + duration_ms * interval '1 ms')) OVER (PARTITION BY camera_id ORDER BY started_at) AS prev_end
         FROM recording_segments WHERE started_at >= '$FROM' AND started_at < '$TO')
     SELECT c.code, to_char(s.prev_end $BR, 'DD/MM HH24:MI:SS'), round(extract(epoch FROM s.started_at - s.prev_end))
       FROM s JOIN cameras c ON c.id = s.camera_id
      WHERE extract(epoch FROM s.started_at - s.prev_end) > 10
      ORDER BY s.started_at - s.prev_end DESC LIMIT 10" |
  while IFS='|' read -r a b c; do echo "- $a: $c s a partir de $b"; done
echo

# ------------------------------------------------------------------ movimento e alarme
if [ "$(sql "SELECT to_regclass('motion_events') IS NOT NULL")" = t ]; then
  echo "## Movimento e alarme"
  echo
  echo "| Câmera | Origem | Movimentos | Avisos | Alarmes enviados | Fora do horário | Intervalo mínimo | Falhas no envio |"
  echo "|---|---|---|---|---|---|---|---|"
  sql "SELECT t.name || ' / ' || c.code, string_agg(DISTINCT m.source, ','), count(*), sum(m.hits),
              count(*) FILTER (WHERE m.alarm_status = 'sent'), count(*) FILTER (WHERE m.alarm_status = 'suppressed_schedule'),
              count(*) FILTER (WHERE m.alarm_status = 'suppressed_cooldown'), count(*) FILTER (WHERE m.alarm_status = 'failed')
         FROM motion_events m JOIN cameras c ON c.id = m.camera_id JOIN tenants t ON t.id = c.tenant_id
        WHERE m.started_at >= '$FROM' AND m.started_at < '$TO'
        GROUP BY t.name, c.code ORDER BY 1" |
    while IFS='|' read -r a b c d e f g h; do echo "| $a | $b | $c | $d | $e | $f | $g | $h |"; done
  echo
  MFAIL=$(sql "SELECT count(*) FROM motion_events WHERE alarm_status = 'failed' AND started_at >= '$FROM'")
  [ "${MFAIL:-0}" -gt 0 ] && ATTN+=("$MFAIL alarme(s) de movimento não enviados (conferir o e-mail em Integrações)")
  DERR=$(sql "SELECT count(*) FROM camera_events WHERE type = 'motion_detector_error' AND occurred_at >= '$FROM'")
  [ "${DERR:-0}" -gt 0 ] && ATTN+=("detector de movimento do servidor falhou $DERR vez(es)")
fi

# ------------------------------------------------------------------ alertas e eventos
echo "## Alertas abertos no período"
echo
echo "| Regra | Gravidade | Quantidade | Ainda abertos |"
echo "|---|---|---|---|"
sql "SELECT rule, severity, count(*), count(*) FILTER (WHERE status <> 'resolved') FROM alerts
      WHERE opened_at >= '$FROM' GROUP BY rule, severity ORDER BY count(*) DESC" |
  while IFS='|' read -r a b c d; do echo "| $a | $b | $c | $d |"; done
echo
OPEN=$(sql "SELECT count(*) FROM alerts WHERE status <> 'resolved'")
[ "${OPEN:-0}" -gt 0 ] && ATTN+=("$OPEN alerta(s) ainda aberto(s): $(sql "SELECT string_agg(left(title, 60), '; ') FROM (SELECT title FROM alerts WHERE status <> 'resolved' ORDER BY opened_at DESC LIMIT 5) x")")
echo "### Eventos por tipo"
echo
sql "SELECT type, count(*) FROM camera_events WHERE occurred_at >= '$FROM' GROUP BY type ORDER BY count(*) DESC LIMIT 15" |
  while IFS='|' read -r a b; do echo "- $a: $b"; done
echo

# ------------------------------------------------------------------ backup
echo "## Backup"
echo
B=$(sql "SELECT count(*) FILTER (WHERE status = 'success'), count(*) FILTER (WHERE status = 'failed'),
                coalesce(pg_size_pretty(avg(size_bytes) FILTER (WHERE status = 'success')::bigint), '—'),
                coalesce(to_char(max(finished_at) FILTER (WHERE status = 'success') $BR, 'DD/MM HH24:MI'), 'nenhum')
           FROM backup_runs WHERE kind = 'backup' AND created_at >= '$FROM'")
IFS='|' read -r bok bfail bsize blast <<<"$B"
echo "Concluídos: **$bok** · falhas: **$bfail** · tamanho médio: $bsize · último: $blast · destino: $(sql "SELECT CASE WHEN value->>'local_only' = 'true' THEN 'somente no servidor' ELSE coalesce(value->>'protocol', '') || '://' || coalesce(value->>'host', '') END FROM system_settings WHERE key = 'integrations.backup'")"
echo
[ "${bok:-0}" -lt "$(( ${SECS:-0} / 86400 ))" ] && ATTN+=("backups concluídos ($bok) abaixo de um por dia")
[ "${bfail:-0}" -gt 0 ] && ATTN+=("$bfail backup(s) falharam")

# ------------------------------------------------------------------ disco de vídeo
echo "## Disco de vídeo"
echo
echo "| Disco | Uso (mín–máx) | Escrita: mediana | 95% | Máxima |"
echo "|---|---|---|---|---|"
sql "SELECT n.name, round(min(x.used_pct), 1) || '% – ' || round(max(x.used_pct), 1) || '%',
            round(percentile_cont(0.5) WITHIN GROUP (ORDER BY x.write_latency_ms)) || ' ms',
            round(percentile_cont(0.95) WITHIN GROUP (ORDER BY x.write_latency_ms)) || ' ms', max(x.write_latency_ms) || ' ms'
       FROM storage_samples x JOIN storage_nodes n ON n.id = x.storage_node_id
      WHERE x.sampled_at >= '$FROM' GROUP BY n.name ORDER BY n.name" |
  while IFS='|' read -r a b c d e; do echo "| $a | $b | $c | $d | $e |"; done
echo
echo "Alertas de disco lento no período: $(sql "SELECT count(*) FROM camera_events WHERE type = 'storage_slow' AND occurred_at >= '$FROM'")"
echo

# ------------------------------------------------------------------ servidor (Prometheus)
echo "## Servidor (Prometheus)"
echo
CPU_AVG=$(prom "avg_over_time((1 - avg(rate(node_cpu_seconds_total{mode=\"idle\"}[5m])))[$PR:5m]) * 100")
CPU_MAX=$(prom "max_over_time((1 - avg(rate(node_cpu_seconds_total{mode=\"idle\"}[5m])))[$PR:5m]) * 100")
MEM_AVG=$(prom "avg_over_time((1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)[$PR:5m]) * 100")
MEM_MAX=$(prom "max_over_time((1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)[$PR:5m]) * 100")
SYS=$(prom "(1 - node_filesystem_avail_bytes{mountpoint=\"/\"} / node_filesystem_size_bytes{mountpoint=\"/\"}) * 100")
IO_MAX=$(prom "max_over_time(rate(node_pressure_io_stalled_seconds_total[5m])[$PR:5m]) * 100")
IO_AVG=$(prom "avg_over_time(rate(node_pressure_io_stalled_seconds_total[5m])[$PR:5m]) * 100")
echo "| Métrica | Média | Máxima |"
echo "|---|---|---|"
echo "| CPU | ${CPU_AVG}% | ${CPU_MAX}% |"
echo "| Memória | ${MEM_AVG}% | ${MEM_MAX}% |"
echo "| E/S travada (tempo com tudo parado esperando o disco) | ${IO_AVG}% | ${IO_MAX}% |"
echo
echo "Disco do sistema agora: ${SYS}% usado."
echo
awk "BEGIN{exit !(${SYS/-/0} > 80)}" && ATTN+=("disco do sistema acima de 80% (${SYS}%)")
awk "BEGIN{exit !(${IO_MAX/-/0} > 50)}" && ATTN+=("houve momentos com mais de 50% do tempo parado esperando o disco (${IO_MAX}%)")

# ------------------------------------------------------------------ resumo
echo "## Pontos de atenção"
echo
if [ ${#ATTN[@]} -eq 0 ]; then echo "Nenhum."; else printf -- '- %s\n' "${ATTN[@]}"; fi
} >"$OUT"

cat "$OUT"
echo
echo "relatório: $OUT"
