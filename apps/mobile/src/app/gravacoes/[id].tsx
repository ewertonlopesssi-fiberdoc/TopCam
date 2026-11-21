import { Ionicons } from "@expo/vector-icons";
import { useEvent, useEventListener } from "expo";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { VideoView, useVideoPlayer, type VideoPlayer } from "expo-video";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import * as MediaLibrary from "expo-media-library/legacy";
import { MonthCalendar } from "../../components/month-calendar";
import { TimeField } from "../../components/time-field";
import { Timeline, type Mark } from "../../components/timeline";
import { Button, Center, ErrorText } from "../../components/ui";
import { ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { colors } from "../../lib/theme";
import {
  addDays,
  atDaySec,
  checkRange,
  chunkFrom,
  clock,
  dayOf,
  dayStart,
  secOfDay,
  toSpans,
  type Span,
} from "../../lib/time";
import { downloadVideo, videosSupported } from "../../lib/videos";

/**
 * Gravações de uma câmera: calendário, linha do tempo (arrastar para ir ao horário), player com
 * voltar/avançar, velocidade até 16x e baixar um trecho (dia + das/às, ou marcado na linha do
 * tempo) para "Meus vídeos".
 * A reprodução usa o mesmo servidor do painel (MP4 contínuo a partir do horário pedido).
 */

interface Summary {
  cameraId: string;
  name: string;
  canExport: boolean;
  newest: string | null;
  oldest: string | null;
}
interface DayData {
  segments: { startedAt: string; endedAt: string }[];
  gaps: { from: string; to: string; internal?: boolean }[];
  motion?: { from: string; to: string; kind: string }[];
}
interface Grant {
  url: string;
  expiresAt: string;
}

const RATES = [1, 2, 4, 8, 16];
const DEFAULT_DL_MS = 5 * 60_000;
const MAX_DL_MS = 3600_000;
/** Último segundo do dia (Brasília) do instante. */
const dayEnd = (ms: number) => dayStart(addDays(dayOf(ms), 1)) - 1000;

function setRate(p: VideoPlayer, r: number) {
  p.playbackRate = r;
}
function setMutedPlayer(p: VideoPlayer, m: boolean) {
  p.muted = m;
}
function setInterval_(p: VideoPlayer) {
  p.timeUpdateEventInterval = 0.5;
}

export default function Gravacoes() {
  const { id, name, t } = useLocalSearchParams<{ id: string; name?: string; t?: string }>();
  const { api } = useAuth();
  const { width } = useWindowDimensions();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [denied, setDenied] = useState<string | null>(null);
  const [day, setDay] = useState<string>(t ? dayOf(Number(t)) : dayOf(Date.now()));
  const [month, setMonth] = useState(day.slice(0, 7));
  const [days, setDays] = useState<Set<string>>(new Set());
  const [data, setData] = useState<DayData | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [rate, setRateState] = useState(1);
  const [muted, setMuted] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [showCal, setShowCal] = useState(false);
  // Trecho para baixar: início e fim (ms). Vêm do cursor, das marcações ou dos campos Das/Às.
  const [dl, setDl] = useState<{
    open: boolean;
    start: number | null;
    end: number | null;
    busy: boolean;
    error: string | null;
  }>({ open: false, start: null, end: null, busy: false, error: null });
  const chunk = useRef<{ start: number; end: number } | null>(null);
  const grant = useRef<Grant | null>(null);
  const pending = useRef<number | null>(t ? Number(t) - 10_000 : null);
  const view = useRef<VideoView>(null);

  const player = useVideoPlayer(null, (p) => {
    setInterval_(p);
    setMutedPlayer(p, true);
  });
  const { isPlaying } = useEvent(player, "playingChange", { isPlaying: player.playing });
  const { status } = useEvent(player, "statusChange", { status: player.status });

  // ---- resumo (permissão), dia inicial
  useEffect(() => {
    api
      .get<Summary>(`/api/v1/cameras/${id}/recordings/summary`)
      .then((s) => {
        setSummary(s);
        if (!t && s.newest) {
          const d = dayOf(Date.parse(s.newest));
          setDay(d);
          setMonth(d.slice(0, 7));
        }
      })
      .catch((e) =>
        setDenied(
          e instanceof ApiError && e.status === 404
            ? "Você não tem permissão para ver as gravações desta câmera."
            : e instanceof ApiError
              ? e.message
              : "Falha ao abrir as gravações",
        ),
      );
  }, [api, id, t]);

  // ---- dias com gravação no mês
  useEffect(() => {
    if (!summary) return;
    const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0));
    api
      .get<{ items: { day: string }[] }>(
        `/api/v1/cameras/${id}/recordings/days?from=${month}-01&to=${last.toISOString().slice(0, 10)}`,
      )
      .then((r) => setDays(new Set(r.items.map((x) => x.day))))
      .catch(() => undefined);
  }, [api, id, month, summary]);

  // ---- linha do tempo do dia (hoje: atualiza a cada minuto)
  const loadDay = useCallback(async () => {
    if (!summary) return;
    const from = dayStart(day);
    const to = Math.min(dayStart(addDays(day, 1)), Date.now());
    if (to <= from) return setData({ segments: [], gaps: [], motion: [] });
    try {
      setData(
        await api.get<DayData>(
          `/api/v1/cameras/${id}/recordings?from=${encodeURIComponent(new Date(from).toISOString())}&to=${encodeURIComponent(new Date(to).toISOString())}`,
        ),
      );
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : "Falha ao carregar o dia");
    }
  }, [api, day, id, summary]);
  useEffect(() => {
    void loadDay();
    if (day !== dayOf(Date.now())) return;
    const tm = setInterval(loadDay, 60_000);
    return () => clearInterval(tm);
  }, [loadDay, day]);

  const spans: Span[] = useMemo(() => toSpans(data?.segments ?? []), [data]);
  const gaps: Mark[] = useMemo(
    () => (data?.gaps ?? []).map((g) => ({ from: Date.parse(g.from), to: Date.parse(g.to) })),
    [data],
  );
  const motion: Mark[] = useMemo(
    () => (data?.motion ?? []).map((g) => ({ from: Date.parse(g.from), to: Date.parse(g.to) })),
    [data],
  );

  const getGrant = useCallback(async () => {
    const g = grant.current;
    if (g && Date.parse(g.expiresAt) - Date.now() > 60_000) return g;
    grant.current = await api.post<Grant>(`/api/v1/cameras/${id}/playback`);
    return grant.current;
  }, [api, id]);

  const load = useCallback(
    async (at: number) => {
      const c = chunkFrom(spans, at);
      if (!c) {
        chunk.current = null;
        player.pause();
        setMessage("Sem gravação a partir deste ponto.");
        return;
      }
      setMessage(null);
      try {
        const g = await getGrant();
        chunk.current = c;
        setCursor(c.start);
        const dur = Math.max(1, Math.ceil((c.end - c.start) / 1000));
        await player.replaceAsync({
          uri: `${api.url(g.url)}&start=${encodeURIComponent(new Date(c.start).toISOString())}&duration=${dur}`,
        });
        setRate(player, rate);
        player.play();
      } catch (e) {
        setMessage(e instanceof ApiError ? e.message : "Não foi possível abrir este trecho.");
      }
    },
    [api, getGrant, player, rate, spans],
  );

  // Abre no horário pedido (alarme) assim que o dia carrega.
  useEffect(() => {
    if (pending.current === null || !spans.length) return;
    const at = pending.current;
    pending.current = null;
    void load(at);
  }, [spans, load]);

  useEventListener(player, "timeUpdate", ({ currentTime }) => {
    const c = chunk.current;
    if (c) setCursor(c.start + currentTime * 1000);
  });
  useEventListener(player, "playToEnd", () => {
    const c = chunk.current;
    if (!c) return;
    const reached = c.start + player.currentTime * 1000;
    const next =
      reached >= c.end - 2000 ? c.end : (spans.find((s) => s.from > reached + 500)?.from ?? c.end);
    void load(next);
  });

  useEffect(() => setMutedPlayer(player, muted), [muted, player]);

  function changeRate(r: number) {
    setRateState(r);
    setRate(player, r);
  }

  function toggle() {
    if (!chunk.current) {
      const first = spans[0];
      if (first) void load(first.from);
      return;
    }
    if (player.playing) player.pause();
    else player.play();
  }

  function pickDay(d: string) {
    setDay(d);
    setMonth(d.slice(0, 7));
    chunk.current = null;
    setCursor(null);
    player.pause();
  }

  const sec = (ms: number) => Math.floor(ms / 1000) * 1000;

  function markStart() {
    if (cursor === null) return;
    const start = sec(cursor);
    setDl((d) => ({
      ...d,
      start,
      end:
        d.end !== null && d.end > start && d.end - start <= MAX_DL_MS
          ? d.end
          : Math.min(start + DEFAULT_DL_MS, dayEnd(start)),
      error: null,
    }));
  }
  function markEnd() {
    if (cursor === null) return;
    const end = sec(cursor);
    setDl((d) => ({
      ...d,
      end,
      start:
        d.start !== null && d.start < end && end - d.start <= MAX_DL_MS
          ? d.start
          : Math.max(end - DEFAULT_DL_MS, dayStart(dayOf(end))),
      error: null,
    }));
  }
  function openDownload() {
    setDl((d) => {
      if (d.start !== null && d.end !== null) return { ...d, open: true, error: null };
      const base = cursor ?? spans.at(-1)?.from ?? dayStart(day);
      const start = sec(base);
      return {
        ...d,
        open: true,
        start,
        end: Math.min(start + DEFAULT_DL_MS, dayEnd(start)),
        error: null,
      };
    });
  }
  /** Troca o dia dentro do "Baixar trecho": mantém os horários e abre o dia na linha do tempo. */
  function dlDay(d: string) {
    setDl((x) =>
      x.start === null || x.end === null
        ? x
        : {
            ...x,
            start: atDaySec(d, secOfDay(x.start)),
            end: atDaySec(d, secOfDay(x.end)),
          },
    );
    pickDay(d);
  }

  async function download() {
    if (dl.start === null || dl.end === null) return;
    const check = checkRange(spans, dl.start, dl.end);
    if (check.error) return setDl((d) => ({ ...d, error: check.error }));
    setDl((d) => ({ ...d, busy: true, error: null }));
    try {
      const start = dl.start;
      const end = check.end;
      const r = await api.post<{ downloadUrl: string; filename: string; seconds: number }>(
        `/api/v1/cameras/${id}/exports`,
        { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
      );
      if (!videosSupported) {
        // Navegador (testes): o próprio navegador baixa o MP4; "Meus vídeos" é só no celular.
        setDl({ open: false, start: null, end: null, busy: false, error: null });
        await Linking.openURL(api.url(r.downloadUrl));
        return;
      }
      const saved = await downloadVideo(
        api.url(r.downloadUrl),
        {},
        { cameraId: id, cameraName: summary?.name ?? name ?? "", start, seconds: r.seconds },
        r.filename,
      );
      setDl({ open: false, start: null, end: null, busy: false, error: null });
      Alert.alert("Vídeo baixado", `${r.filename}\nEstá em "Meus vídeos".`, [
        { text: "OK" },
        {
          text: "Salvar na galeria",
          onPress: async () => {
            const p = await MediaLibrary.requestPermissionsAsync(true);
            if (!p.granted)
              return Alert.alert("Sem permissão", "Permita o acesso às fotos e vídeos.");
            await MediaLibrary.saveToLibraryAsync(saved.uri);
            Alert.alert("Pronto", "O vídeo foi salvo na galeria.");
          },
        },
      ]);
    } catch (e) {
      setDl((d) => ({
        ...d,
        busy: false,
        error: e instanceof ApiError ? e.message : "Falha ao baixar o vídeo",
      }));
    }
  }

  if (denied)
    return (
      <Center>
        <Ionicons name="lock-closed" size={32} color={colors.muted} />
        <Text style={{ color: colors.muted, textAlign: "center" }}>{denied}</Text>
      </Center>
    );
  if (!summary)
    return (
      <Center>
        <ActivityIndicator />
      </Center>
    );

  const busy = status === "loading";
  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
      <Stack.Screen options={{ title: summary.name ?? name ?? "Gravações" }} />
      <View style={{ width, height: (width * 9) / 16, backgroundColor: "#000" }}>
        <VideoView
          ref={view}
          player={player}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          nativeControls={false}
          fullscreenOptions={{ enable: true }}
          testID="app-playback"
        />
        {busy && (
          <View style={st.overlay} pointerEvents="none">
            <ActivityIndicator color="#fff" />
          </View>
        )}
        {!chunk.current && !busy && (
          <Pressable style={st.overlay} onPress={toggle} accessibilityLabel="Reproduzir">
            <Ionicons name="play-circle" size={56} color="#fff" />
            <Text style={{ color: "#e2e8f0" }}>
              {spans.length ? "Toque para reproduzir" : "Sem gravação neste dia"}
            </Text>
          </Pressable>
        )}
        {cursor !== null && (
          <View style={st.clock} pointerEvents="none">
            <Text style={st.clockText}>{clock(cursor)}</Text>
          </View>
        )}
      </View>

      <View style={st.controls}>
        <Ctl
          icon="play-back"
          label="Voltar 30 s"
          onPress={() => cursor !== null && void load(cursor - 30_000)}
        />
        <Ctl
          icon="refresh"
          flip
          label="Voltar 10 s"
          onPress={() => cursor !== null && void load(cursor - 10_000)}
        />
        <Pressable
          onPress={toggle}
          style={st.play}
          accessibilityRole="button"
          accessibilityLabel={isPlaying ? "Pausar" : "Reproduzir"}
        >
          <Ionicons name={isPlaying ? "pause" : "play"} size={28} color="#fff" />
        </Pressable>
        <Ctl
          icon="refresh"
          label="Avançar 10 s"
          onPress={() => cursor !== null && void load(cursor + 10_000)}
        />
        <Ctl
          icon="play-forward"
          label="Avançar 30 s"
          onPress={() => cursor !== null && void load(cursor + 30_000)}
        />
      </View>

      <View style={st.row}>
        {RATES.map((r) => (
          <Pressable
            key={r}
            onPress={() => changeRate(r)}
            style={[st.rate, rate === r && st.rateOn]}
            accessibilityRole="button"
            accessibilityLabel={`Velocidade ${r}x`}
            accessibilityState={{ selected: rate === r }}
          >
            <Text style={[st.rateText, rate === r && { color: "#fff" }]}>{r}x</Text>
          </Pressable>
        ))}
        <Pressable
          onPress={() => setMuted((m) => !m)}
          style={st.rate}
          accessibilityLabel={muted ? "Ligar som" : "Desligar som"}
        >
          <Ionicons name={muted ? "volume-mute" : "volume-high"} size={16} color={colors.ink} />
        </Pressable>
        <Pressable
          onPress={() => void view.current?.enterFullscreen()}
          style={st.rate}
          accessibilityLabel="Tela cheia"
        >
          <Ionicons name="expand" size={16} color={colors.ink} />
        </Pressable>
      </View>

      <View style={{ padding: 16, gap: 12 }}>
        <ErrorText>{message}</ErrorText>
        <Pressable
          style={st.dayBtn}
          onPress={() => setShowCal((v) => !v)}
          accessibilityRole="button"
          accessibilityLabel="Escolher dia"
        >
          <Ionicons name="calendar" size={18} color={colors.primary} />
          <Text style={st.dayText}>
            {day.slice(8, 10)}/{day.slice(5, 7)}/{day.slice(0, 4)}
          </Text>
          <Ionicons name={showCal ? "chevron-up" : "chevron-down"} size={18} color={colors.muted} />
        </Pressable>
        {showCal && (
          <MonthCalendar
            month={month}
            days={days}
            selected={day}
            onMonth={setMonth}
            onSelect={(d) => {
              setShowCal(false);
              pickDay(d);
            }}
          />
        )}
        {data ? (
          <Timeline
            day={day}
            spans={spans}
            gaps={gaps}
            motion={motion}
            cursor={cursor}
            onSeek={(ms) => void load(ms)}
          />
        ) : (
          <ActivityIndicator />
        )}
        {summary.canExport && (
          <View style={{ gap: 8 }}>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Pressable
                style={[st.mark, cursor === null && { opacity: 0.4 }]}
                disabled={cursor === null}
                onPress={markStart}
                accessibilityRole="button"
                accessibilityLabel="Marcar início aqui"
              >
                <Ionicons name="flag-outline" size={16} color={colors.primary} />
                <Text style={st.markText}>Marcar início aqui</Text>
              </Pressable>
              <Pressable
                style={[st.mark, cursor === null && { opacity: 0.4 }]}
                disabled={cursor === null}
                onPress={markEnd}
                accessibilityRole="button"
                accessibilityLabel="Marcar fim aqui"
              >
                <Ionicons name="flag" size={16} color={colors.primary} />
                <Text style={st.markText}>Marcar fim aqui</Text>
              </Pressable>
            </View>
            {dl.start !== null && dl.end !== null && (
              <Text style={{ color: colors.ink, textAlign: "center" }} testID="dl-marked">
                Trecho: das {clock(dl.start)} às {clock(dl.end)}
              </Text>
            )}
            <Button
              label="Baixar trecho"
              icon="cloud-download"
              variant="secondary"
              disabled={!spans.length}
              onPress={openDownload}
            />
          </View>
        )}
      </View>

      <Modal
        visible={dl.open}
        transparent
        animationType="fade"
        onRequestClose={() => setDl((d) => ({ ...d, open: false }))}
      >
        <View style={st.modalBg}>
          <View style={st.modal}>
            <ScrollView contentContainerStyle={{ gap: 10 }} keyboardShouldPersistTaps="handled">
              <Text style={st.modalTitle}>Baixar trecho</Text>
              {dl.start !== null && dl.end !== null && (
                <>
                  <MonthCalendar
                    month={month}
                    days={days}
                    selected={day}
                    onMonth={setMonth}
                    onSelect={dlDay}
                  />
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <TimeField
                      label="Das"
                      value={secOfDay(dl.start)}
                      onChange={(v) =>
                        setDl((d) => ({ ...d, start: atDaySec(day, v), error: null }))
                      }
                    />
                    <TimeField
                      label="Às"
                      value={secOfDay(dl.end)}
                      onChange={(v) => setDl((d) => ({ ...d, end: atDaySec(day, v), error: null }))}
                    />
                  </View>
                  <RangeInfo spans={spans} start={dl.start} end={dl.end} />
                </>
              )}
              <ErrorText>{dl.error}</ErrorText>
              <Button
                label="Baixar"
                icon="cloud-download"
                busy={dl.busy}
                onPress={() => void download()}
              />
              <Button
                label="Cancelar"
                variant="secondary"
                onPress={() => setDl((d) => ({ ...d, open: false }))}
              />
            </ScrollView>
          </View>
        </View>
      </Modal>
      <Pressable
        onPress={() => router.navigate("/(tabs)/videos")}
        style={{ alignSelf: "center", padding: 8 }}
      >
        <Text style={{ color: colors.primary, fontWeight: "600" }}>Ver meus vídeos</Text>
      </Pressable>
    </ScrollView>
  );
}

/** Resumo do trecho escolhido: duração, avisos e o que impede de baixar. */
function RangeInfo({ spans, start, end }: { spans: Span[]; start: number; end: number }) {
  const c = checkRange(spans, start, end);
  if (c.error)
    return (
      <Text style={{ color: colors.danger }} testID="dl-check">
        {c.error}
      </Text>
    );
  const s = Math.round((c.end - start) / 1000);
  const len = s >= 60 ? `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}` : `${s} s`;
  return (
    <View style={{ gap: 4 }} testID="dl-check">
      <Text style={{ color: colors.ink, fontWeight: "600" }}>
        {clock(start)} às {clock(c.end)} · {len}
      </Text>
      {c.clamped && (
        <Text style={{ color: colors.muted, fontSize: 12 }}>
          O fim foi ajustado para o último horário já gravado.
        </Text>
      )}
      {c.missing.length > 0 && (
        <Text style={{ color: "#b45309", fontSize: 12 }}>
          Sem gravação{" "}
          {c.missing
            .slice(0, 3)
            .map((m) => `das ${clock(m.from)} às ${clock(m.to)}`)
            .join(", ")}
          {c.missing.length > 3 ? ` e mais ${c.missing.length - 3}` : ""}. O vídeo pula esse
          intervalo.
        </Text>
      )}
    </View>
  );
}

function Ctl({
  icon,
  label,
  onPress,
  flip,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  flip?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={st.ctl}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Ionicons
        name={icon}
        size={22}
        color={colors.ink}
        style={flip ? { transform: [{ scaleX: -1 }] } : undefined}
      />
      <Text style={st.ctlText}>{label.replace(/^(Voltar|Avançar) /, "")}</Text>
    </Pressable>
  );
}

const st = StyleSheet.create({
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  clock: {
    position: "absolute",
    bottom: 8,
    alignSelf: "center",
    backgroundColor: "#000000aa",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  clockText: { color: "#fff", fontVariant: ["tabular-nums"], fontWeight: "600" },
  controls: {
    flexDirection: "row",
    justifyContent: "space-around",
    alignItems: "center",
    paddingVertical: 12,
    backgroundColor: "#fff",
  },
  ctl: { alignItems: "center", gap: 2, padding: 4 },
  ctlText: { fontSize: 11, color: colors.muted },
  play: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 16, paddingTop: 12 },
  rate: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: "#fff",
  },
  rateOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  rateText: { color: colors.ink, fontWeight: "600" },
  dayBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 12,
  },
  dayText: { flex: 1, fontSize: 16, fontWeight: "600", color: colors.ink },
  modalBg: { flex: 1, backgroundColor: "#00000088", justifyContent: "center", padding: 16 },
  modal: { backgroundColor: "#fff", borderRadius: 16, padding: 16, maxHeight: "95%" },
  mark: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 10,
    paddingVertical: 10,
    backgroundColor: "#fff",
  },
  markText: { color: colors.primary, fontWeight: "600" },
  modalTitle: { fontSize: 18, fontWeight: "700", color: colors.ink },
});
