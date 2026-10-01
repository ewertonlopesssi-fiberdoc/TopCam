import { Stack, router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { LivePlayer } from "../components/live-player";
import { pages } from "../lib/cameras";
import { colors } from "../lib/theme";

/** Mosaico de até 4 câmeras (páginas se houver mais). Tocar numa abre o ao vivo dela. */
export default function Mosaico() {
  const { ids, title } = useLocalSearchParams<{ ids: string; title?: string }>();
  const all = (ids ?? "").split(",").filter(Boolean);
  const pgs = pages(all, 4);
  const [page, setPage] = useState(0);
  const cur = pgs[page] ?? [];

  return (
    <View style={{ flex: 1, backgroundColor: "#000" }}>
      <Stack.Screen options={{ title: title ? `Mosaico · ${title}` : "Mosaico" }} />
      <View style={st.grid}>
        {[0, 1, 2, 3].map((i) => (
          <View key={`${page}-${i}`} style={st.cell}>
            {cur[i] ? (
              <LivePlayer
                cameraId={cur[i]}
                compact
                onPress={() => router.push({ pathname: "/camera/[id]", params: { id: cur[i]! } })}
              />
            ) : null}
          </View>
        ))}
      </View>
      {pgs.length > 1 && (
        <View style={st.pager}>
          {pgs.map((_, i) => (
            <Pressable
              key={i}
              onPress={() => setPage(i)}
              accessibilityRole="button"
              accessibilityLabel={`Página ${i + 1}`}
              style={[st.pg, i === page && { backgroundColor: colors.primary }]}
            >
              <Text style={st.pgText}>{i + 1}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  grid: { flex: 1, flexDirection: "row", flexWrap: "wrap" },
  cell: { width: "50%", height: "50%", borderWidth: 1, borderColor: "#111" },
  pager: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 8,
    padding: 12,
    backgroundColor: colors.dark,
  },
  pg: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#334155",
  },
  pgText: { color: "#fff", fontWeight: "600" },
});
