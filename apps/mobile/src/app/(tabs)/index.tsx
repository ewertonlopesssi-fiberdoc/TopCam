import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useMemo, useState } from "react";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { CameraThumb } from "../../components/camera-thumb";
import { Center, ErrorText, StatusBadge } from "../../components/ui";
import { buildTree, isOnline } from "../../lib/cameras";
import { colors } from "../../lib/theme";
import { useCameras } from "../../lib/use-cameras";

/** Câmeras liberadas para o usuário, com a foto de cada uma, por local e grupo. */
export default function Cameras() {
  const { cams, error, reload } = useCameras();
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");

  const tree = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = (cams ?? []).filter(
      (c) => !q || c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q),
    );
    return buildTree(list);
  }, [cams, search]);

  if (!cams && !error)
    return (
      <Center>
        <Text style={{ color: colors.muted }}>Carregando câmeras…</Text>
      </Center>
    );

  return (
    <ScrollView
      contentContainerStyle={st.wrap}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await reload();
            setRefreshing(false);
          }}
        />
      }
    >
      <ErrorText>{error}</ErrorText>
      {cams && cams.length > 4 && (
        <View style={st.search}>
          <Ionicons name="search" size={18} color={colors.muted} />
          <TextInput
            style={st.searchInput}
            placeholder="Pesquisar câmera"
            placeholderTextColor="#94a3b8"
            value={search}
            onChangeText={setSearch}
            accessibilityLabel="Pesquisar câmera"
          />
        </View>
      )}
      {cams && cams.length === 0 && (
        <Center>
          <Ionicons name="videocam-off-outline" size={40} color={colors.muted} />
          <Text style={st.empty}>Nenhuma câmera liberada para você. Fale com o administrador.</Text>
        </Center>
      )}
      {tree.map((sec) => (
        <View key={sec.key} style={{ gap: 10 }} testID="camera-section">
          <View style={st.secHead}>
            <Ionicons name="location" size={16} color={colors.primary} />
            <Text style={st.secTitle}>{sec.title}</Text>
          </View>
          {sec.groups.map((g) => {
            const online = g.cameras.filter((c) => isOnline(c.status));
            return (
              <View key={g.key} style={{ gap: 8 }}>
                <View style={st.groupHead}>
                  <Text style={st.groupTitle}>{g.title}</Text>
                  {online.length >= 2 && (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Mosaico de ${g.title}`}
                      style={st.mosaicBtn}
                      onPress={() =>
                        router.navigate({ pathname: "/(tabs)/mosaico", params: { group: g.key } })
                      }
                    >
                      <Ionicons name="grid" size={14} color={colors.primary} />
                      <Text style={st.mosaicText}>Mosaico</Text>
                    </Pressable>
                  )}
                </View>
                {g.cameras.map((c) => (
                  <Pressable
                    key={c.id}
                    testID="camera-row"
                    accessibilityRole="button"
                    accessibilityLabel={`${c.name}, ${c.code}`}
                    onPress={() =>
                      router.push({
                        pathname: "/camera/[id]",
                        params: { id: c.id, name: c.name, rec: c.recordingEnabled ? "1" : "0" },
                      })
                    }
                    style={({ pressed }) => [st.row, pressed && { opacity: 0.8 }]}
                  >
                    <CameraThumb cameraId={c.id} style={st.thumb} />
                    <View style={st.info}>
                      <Text style={st.name} numberOfLines={2}>
                        {c.name}
                      </Text>
                      <Text style={st.code}>{c.code}</Text>
                      <StatusBadge status={c.status} />
                    </View>
                    {c.recordingEnabled && (
                      <Pressable
                        style={st.recBtn}
                        accessibilityRole="button"
                        accessibilityLabel={`Gravações de ${c.name}`}
                        onPress={() =>
                          router.push({
                            pathname: "/gravacoes/[id]",
                            params: { id: c.id, name: c.name },
                          })
                        }
                      >
                        <Ionicons name="film" size={20} color={colors.primary} />
                        <Text style={st.recText}>Gravações</Text>
                      </Pressable>
                    )}
                  </Pressable>
                ))}
              </View>
            );
          })}
        </View>
      ))}
    </ScrollView>
  );
}

const st = StyleSheet.create({
  wrap: { padding: 16, gap: 18, flexGrow: 1 },
  empty: { color: colors.muted, textAlign: "center" },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingHorizontal: 12,
  },
  searchInput: { flex: 1, height: 44, fontSize: 16, color: colors.ink },
  secHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  secTitle: { fontSize: 16, fontWeight: "700", color: colors.ink },
  groupHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  groupTitle: { fontSize: 13, fontWeight: "600", color: colors.muted, textTransform: "uppercase" },
  mosaicBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  mosaicText: { color: colors.primary, fontWeight: "600", fontSize: 13 },
  row: {
    flexDirection: "row",
    gap: 12,
    backgroundColor: "#fff",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.line,
    overflow: "hidden",
  },
  thumb: { width: 150, aspectRatio: 16 / 9 },
  info: { flex: 1, paddingVertical: 10, paddingRight: 10, gap: 4, alignItems: "flex-start" },
  name: { fontSize: 16, fontWeight: "600", color: colors.ink },
  code: { fontSize: 12, color: colors.muted },
  recBtn: { alignItems: "center", justifyContent: "center", gap: 2, paddingHorizontal: 10 },
  recText: { fontSize: 10, color: colors.primary, fontWeight: "600" },
});
