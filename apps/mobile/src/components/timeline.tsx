import { useEffect, useMemo, useRef, useState } from "react";
import {
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { clock, dayStart, addDays, type Span } from "../lib/time";
import { colors } from "../lib/theme";

/**
 * Linha do tempo do dia (igual ao painel): gravado em azul, movimento em âmbar, lacunas de
 * sinal em vermelho. Arrastar move o cursor; soltar vai para o horário. Zoom de 24 h, 6 h e 1 h.
 */
export interface Mark {
  from: number;
  to: number;
}

const ZOOMS = [
  { h: 24, label: "24 h", step: 6 },
  { h: 6, label: "6 h", step: 1 },
  { h: 1, label: "1 h", step: 1 / 6 },
];

export function Timeline({
  day,
  spans,
  gaps,
  motion,
  cursor,
  onSeek,
}: {
  day: string;
  spans: Span[];
  gaps: Mark[];
  motion: Mark[];
  cursor: number | null;
  onSeek: (ms: number) => void;
}) {
  const [zoom, setZoom] = useState(0);
  const [w, setW] = useState(1);
  const [drag, setDrag] = useState<number | null>(null);
  const start = dayStart(day);
  const end = dayStart(addDays(day, 1));
  const len = ZOOMS[zoom]!.h * 3600_000;
  const center = drag ?? cursor ?? spans.at(-1)?.to ?? start + len / 2;
  const winStart = Math.min(Math.max(start, center - len / 2), end - len);
  const winEnd = winStart + len;
  const x = (ms: number) => ((Math.min(Math.max(ms, winStart), winEnd) - winStart) / len) * w;

  // O gesto usa sempre a janela do início do arraste (senão ela anda junto com o dedo).
  const g = useRef({ winStart, len, w });
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) g.current = { winStart, len, w };
  }, [dragging, winStart, len, w]);
  // Os gestos leem a janela (ref) só quando o dedo se move, não durante a renderização.
  /* eslint-disable react-hooks/refs */
  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => {
          const s = g.current;
          setDrag(s.winStart + (e.nativeEvent.locationX / s.w) * s.len);
        },
        onPanResponderMove: (e) => {
          const s = g.current;
          const px = Math.min(Math.max(e.nativeEvent.locationX, 0), s.w);
          setDrag(s.winStart + (px / s.w) * s.len);
        },
        onPanResponderRelease: (e) => {
          const s = g.current;
          const px = Math.min(Math.max(e.nativeEvent.locationX, 0), s.w);
          setDrag(null);
          onSeek(s.winStart + (px / s.w) * s.len);
        },
        onPanResponderTerminate: () => setDrag(null),
      }),
    [onSeek],
  );
  /* eslint-enable react-hooks/refs */

  const ticks: number[] = [];
  const stepMs = ZOOMS[zoom]!.step * 3600_000;
  for (let t = start; t <= end; t += stepMs) if (t >= winStart && t <= winEnd) ticks.push(t);
  const shown = drag ?? cursor;

  return (
    <View style={st.wrap} testID="app-timeline">
      <View style={st.head}>
        <Text style={st.now}>{shown ? clock(shown) : "--:--:--"}</Text>
        <View style={st.zooms}>
          {ZOOMS.map((z, i) => (
            <Pressable
              key={z.h}
              onPress={() => setZoom(i)}
              style={[st.zoom, zoom === i && st.zoomOn]}
              accessibilityRole="button"
              accessibilityState={{ selected: zoom === i }}
            >
              <Text style={[st.zoomText, zoom === i && { color: "#fff" }]}>{z.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
      <View
        style={st.track}
        onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)}
        {...pan.panHandlers}
        accessibilityRole="adjustable"
        accessibilityLabel="Linha do tempo"
      >
        {spans.map((s) =>
          s.to > winStart && s.from < winEnd ? (
            <View
              key={`s${s.from}`}
              style={[st.bar, st.rec, { left: x(s.from), width: Math.max(x(s.to) - x(s.from), 1) }]}
            />
          ) : null,
        )}
        {motion.map((m) =>
          m.to > winStart && m.from < winEnd ? (
            <View
              key={`m${m.from}`}
              testID="app-timeline-motion"
              style={[
                st.bar,
                st.motion,
                { left: x(m.from), width: Math.max(x(m.to) - x(m.from), 2) },
              ]}
            />
          ) : null,
        )}
        {gaps.map((m) =>
          m.to > winStart && m.from < winEnd ? (
            <View
              key={`g${m.from}`}
              style={[st.bar, st.gap, { left: x(m.from), width: Math.max(x(m.to) - x(m.from), 2) }]}
            />
          ) : null,
        )}
        {shown !== null && shown >= winStart && shown <= winEnd && (
          <View style={[st.cursor, { left: x(shown) - 1 }]} pointerEvents="none" />
        )}
      </View>
      <View style={st.ticks}>
        {ticks.map((t) => (
          <Text key={t} style={[st.tick, { left: x(t) - 16 }]}>
            {t === end ? "24:00" : clock(t, false)}
          </Text>
        ))}
      </View>
      <View style={st.legend}>
        <Legend color="#2f74f5" label="Gravado" />
        <Legend color="#fbbf24" label={`Movimento (${motion.length})`} />
        <Legend color="#f87171" label="Lacuna de sinal" />
      </View>
    </View>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <View style={{ width: 12, height: 8, borderRadius: 2, backgroundColor: color }} />
      <Text style={{ fontSize: 11, color: colors.muted }}>{label}</Text>
    </View>
  );
}

const st = StyleSheet.create({
  wrap: {
    backgroundColor: "#fff",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 12,
    gap: 8,
  },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  now: { fontSize: 20, fontWeight: "700", color: colors.ink, fontVariant: ["tabular-nums"] },
  zooms: {
    flexDirection: "row",
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    overflow: "hidden",
  },
  zoom: { paddingHorizontal: 10, paddingVertical: 6 },
  zoomOn: { backgroundColor: colors.primary },
  zoomText: { fontSize: 12, color: colors.ink },
  track: { height: 48, backgroundColor: "#e2e8f0", borderRadius: 6, overflow: "hidden" },
  bar: { position: "absolute", top: 0, bottom: 0 },
  rec: { backgroundColor: "#2f74f5" },
  motion: { backgroundColor: "#fbbf24" },
  gap: { backgroundColor: "#f87171" },
  cursor: { position: "absolute", top: 0, bottom: 0, width: 3, backgroundColor: "#0f172a" },
  ticks: { height: 14 },
  tick: { position: "absolute", width: 32, textAlign: "center", fontSize: 10, color: colors.muted },
  legend: { flexDirection: "row", gap: 12, flexWrap: "wrap" },
});
