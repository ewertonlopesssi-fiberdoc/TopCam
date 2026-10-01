import { Ionicons } from "@expo/vector-icons";
import { router, useIsFocused, useLocalSearchParams } from "expo-router";
import { useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LivePlayer } from "../../components/live-player";
import { Center } from "../../components/ui";
import { buildTree, isOnline, pages, type Camera } from "../../lib/cameras";
import { colors } from "../../lib/theme";
import { useCameras } from "../../lib/use-cameras";

/**
 * Mosaico ao vivo de 1, 4 ou 9 câmeras (páginas se houver mais), por grupo ou todas.
 * Tocar numa câmera amplia ali mesmo; as outras param até voltar ao mosaico.
 */
const LAYOUTS = [1, 4, 9] as const;

export default function Mosaico() {
  const params = useLocalSearchParams<{ group?: string }>();
  const { cams } = useCameras();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [scope, setScope] = useState<string>(params.group ?? "all");
  const [layout, setLayout] = useState<(typeof LAYOUTS)[number]>(4);
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<Camera | null>(null);
  const [muted, setMuted] = useState(true);
  const full = useRef<(() => void) | null>(null);
  // Fora desta aba (ou com outra tela por cima) os vídeos param: não gasta dados nem bateria.
  const focused = useIsFocused();

  // Veio do botão "Mosaico" de um grupo na lista (ajusta durante a renderização, sem efeito).
  const [seenGroup, setSeenGroup] = useState(params.group);
  if (params.group !== seenGroup) {
    setSeenGroup(params.group);
    if (params.group) {
      setScope(params.group);
      setPage(0);
      setExpanded(null);
    }
  }

  const scopes = useMemo(() => {
    const out: { key: string; title: string; cameras: Camera[] }[] = [];
    const online = (cams ?? []).filter((c) => isOnline(c.status));
    out.push({ key: "all", title: "Todas", cameras: online });
    for (const s of buildTree(cams ?? []))
      for (const g of s.groups) {
        const on = g.cameras.filter((c) => isOnline(c.status));
        if (on.length) out.push({ key: g.key, title: `${s.title} › ${g.title}`, cameras: on });
      }
    return out;
  }, [cams]);

  const current = scopes.find((s) => s.key === scope) ?? scopes[0]!;
  const pgs = pages(current.cameras, layout);
  const pageIdx = Math.min(page, Math.max(pgs.length - 1, 0));
  const shown = pgs[pageIdx] ?? [];
  const cols = layout === 1 ? 1 : layout === 4 ? 2 : 3;
  const cellW = width / cols;

  if (!cams)
    return (
      <Center>
        <Text style={{ color: colors.muted }}>Carregando câmeras…</Text>
      </Center>
    );

  if (expanded)
    return (
      <View style={[st.dark, { paddingBottom: insets.bottom }]}>
        <View style={{ width, height: (width * 9) / 16 }}>
          {focused && <LivePlayer cameraId={expanded.id} muted={muted} fullscreenRef={full} />}
        </View>
        <Text style={st.expTitle}>{expanded.name}</Text>
        <View style={st.expBar}>
          <Tool icon="arrow-back" label="Voltar ao mosaico" onPress={() => setExpanded(null)} />
          <Tool
            icon={muted ? "volume-mute" : "volume-high"}
            label={muted ? "Ligar som" : "Desligar som"}
            onPress={() => setMuted((m) => !m)}
          />
          <Tool icon="expand" label="Tela cheia" onPress={() => full.current?.()} />
          {expanded.recordingEnabled && (
            <Tool
              icon="film"
              label="Gravações"
              onPress={() =>
                router.push({
                  pathname: "/gravacoes/[id]",
                  params: { id: expanded.id, name: expanded.name },
                })
              }
            />
          )}
        </View>
      </View>
    );

  return (
    <View style={st.dark}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={st.scopes}
        contentContainerStyle={{ gap: 8, paddingHorizontal: 12 }}
      >
        {scopes.map((s) => (
          <Pressable
            key={s.key}
            onPress={() => (setScope(s.key), setPage(0))}
            accessibilityRole="button"
            accessibilityState={{ selected: s.key === current.key }}
            style={[st.chip, s.key === current.key && st.chipOn]}
          >
            <Text style={[st.chipText, s.key === current.key && { color: "#fff" }]}>
              {s.title} ({s.cameras.length})
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      <View style={st.layouts}>
        {LAYOUTS.map((n) => (
          <Pressable
            key={n}
            onPress={() => (setLayout(n), setPage(0))}
            accessibilityRole="button"
            accessibilityLabel={`Mosaico de ${n}`}
            accessibilityState={{ selected: layout === n }}
            style={[st.layoutBtn, layout === n && st.chipOn]}
          >
            <Ionicons
              name={n === 1 ? "square" : n === 4 ? "grid" : "apps"}
              size={16}
              color={layout === n ? "#fff" : "#cbd5e1"}
            />
            <Text style={[st.chipText, layout === n && { color: "#fff" }]}>{n}</Text>
          </Pressable>
        ))}
      </View>

      {shown.length === 0 ? (
        <Center>
          <Ionicons name="videocam-off-outline" size={36} color="#64748b" />
          <Text style={{ color: "#cbd5e1", textAlign: "center" }}>
            Nenhuma câmera no ar neste grupo agora.
          </Text>
        </Center>
      ) : (
        <ScrollView contentContainerStyle={st.grid}>
          {shown.map((c) => (
            <View
              key={`${layout}-${pageIdx}-${c.id}`}
              style={{ width: cellW, height: (cellW * 9) / 16 }}
            >
              {focused && (
                <LivePlayer cameraId={c.id} compact={layout > 1} onPress={() => setExpanded(c)} />
              )}
              {layout > 1 && (
                <Text style={st.label} numberOfLines={1} pointerEvents="none">
                  {c.name}
                </Text>
              )}
            </View>
          ))}
        </ScrollView>
      )}

      {pgs.length > 1 && (
        <View style={[st.pager, { paddingBottom: 12 }]}>
          <Pressable
            disabled={pageIdx === 0}
            onPress={() => setPage(pageIdx - 1)}
            accessibilityLabel="Página anterior"
            style={[st.pg, pageIdx === 0 && { opacity: 0.3 }]}
          >
            <Ionicons name="chevron-back" size={18} color="#fff" />
          </Pressable>
          <Text style={st.pgText}>
            {pageIdx + 1} de {pgs.length}
          </Text>
          <Pressable
            disabled={pageIdx >= pgs.length - 1}
            onPress={() => setPage(pageIdx + 1)}
            accessibilityLabel="Próxima página"
            style={[st.pg, pageIdx >= pgs.length - 1 && { opacity: 0.3 }]}
          >
            <Ionicons name="chevron-forward" size={18} color="#fff" />
          </Pressable>
        </View>
      )}
    </View>
  );
}

function Tool({
  icon,
  label,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={st.tool}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Ionicons name={icon} size={22} color="#fff" />
      <Text style={st.toolText}>{label}</Text>
    </Pressable>
  );
}

const st = StyleSheet.create({
  dark: { flex: 1, backgroundColor: "#0b1220" },
  scopes: { flexGrow: 0, paddingVertical: 10 },
  chip: {
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: "#1e293b",
  },
  chipOn: { backgroundColor: colors.primary },
  chipText: { color: "#cbd5e1", fontWeight: "600", fontSize: 13 },
  layouts: { flexDirection: "row", gap: 8, paddingHorizontal: 12, paddingBottom: 10 },
  layoutBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: "#1e293b",
  },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  label: {
    position: "absolute",
    left: 4,
    top: 4,
    color: "#fff",
    fontSize: 11,
    backgroundColor: "#00000088",
    paddingHorizontal: 4,
    borderRadius: 4,
    maxWidth: "90%",
  },
  pager: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 16,
    paddingTop: 12,
  },
  pg: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#334155",
  },
  pgText: { color: "#fff", fontWeight: "600" },
  expTitle: { color: "#fff", fontSize: 18, fontWeight: "700", padding: 16 },
  expBar: { flexDirection: "row", flexWrap: "wrap", gap: 10, paddingHorizontal: 16 },
  tool: {
    width: "47%",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#1e293b",
    borderRadius: 10,
    padding: 14,
  },
  toolText: { color: "#fff", fontWeight: "500" },
});
