import { Ionicons } from "@expo/vector-icons";
import { useEvent, useEventListener } from "expo";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { VideoView, useVideoPlayer, type VideoPlayer } from "expo-video";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
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
import { Timeline, type Mark } from "../../components/timeline";
import { Button, Center, ErrorText } from "../../components/ui";
import { ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { colors } from "../../lib/theme";
import { addDays, chunkFrom, clock, dayOf, dayStart, toSpans, type Span } from "../../lib/time";
import { downloadVideo, videosSupported } from "../../lib/videos";

/**
 * Gravações de uma câmera: calendário, linha do tempo (arrastar para ir ao horário), player com
 * voltar/avançar, velocidade até 16x e baixar um trecho para "Meus vídeos".
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
const DURATIONS = [1, 5, 10, 30, 60];

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
  const [dl, setDl] = useState<{
    open: boolean;
    minutes: number;
    busy: boolean;
    error: string | null;
  }>({
    open: false,
    minutes: 5,
    busy: false,
    error: null,
  });
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

  async function download() {
    if (cursor === null) return;
    setDl((d) => ({ ...d, busy: true, error: null }));
    try {
      const start = Math.floor(cursor / 1000) * 1000;
      const end = Math.min(start + dl.minutes * 60_000, Date.now() - 5000);
      const r = await api.post<{ downloadUrl: string; filename: string; seconds: number }>(
        `/api/v1/cameras/${id}/exports`,
        { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
      );
      const saved = await downloadVideo(
        api.url(r.downloadUrl),
        {},
        { cameraId: id, cameraName: summary?.name ?? name ?? "", start, seconds: r.seconds },
        r.filename,
      );
      setDl({ open: false, minutes: dl.minutes, busy: false, error: null });
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
              setDay(d);
              setShowCal(false);
              chunk.current = null;
              setCursor(null);
              player.pause();
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
        {summary.canExport && videosSupported && (
          <Button
            label="Baixar trecho"
            icon="cloud-download"
            variant="secondary"
            disabled={cursor === null}
            onPress={() => setDl((d) => ({ ...d, open: true, error: null }))}
          />
        )}
        {summary.canExport && !videosSupported && (
          <Text style={{ color: colors.muted, fontSize: 12 }}>
            Baixar trechos funciona no app do celular.
          </Text>
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
            <Text style={st.modalTitle}>Baixar trecho</Text>
            <Text style={{ color: colors.muted }}>
              A partir de {cursor !== null ? clock(cursor) : "--"} ({day.slice(8, 10)}/
              {day.slice(5, 7)}), duração:
            </Text>
            <View style={st.row}>
              {DURATIONS.map((m) => (
                <Pressable
                  key={m}
                  onPress={() => setDl((d) => ({ ...d, minutes: m }))}
                  style={[st.rate, dl.minutes === m && st.rateOn]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: dl.minutes === m }}
                >
                  <Text style={[st.rateText, dl.minutes === m && { color: "#fff" }]}>{m} min</Text>
                </Pressable>
              ))}
            </View>
            {cursor !== null && (
              <Text style={{ color: colors.ink }}>
                Das {clock(cursor)} às {clock(Math.min(cursor + dl.minutes * 60_000, Date.now()))}
              </Text>
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
  modalBg: { flex: 1, backgroundColor: "#00000088", justifyContent: "center", padding: 20 },
  modal: { backgroundColor: "#fff", borderRadius: 16, padding: 20, gap: 12 },
  modalTitle: { fontSize: 18, fontWeight: "700", color: colors.ink },
});
