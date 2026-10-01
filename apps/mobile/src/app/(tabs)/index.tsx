import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { Card, Center, ErrorText, StatusBadge } from "../../components/ui";
import { ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { buildTree, isOnline, type Camera } from "../../lib/cameras";
import { colors } from "../../lib/theme";

/** Câmeras liberadas para o usuário, por local e grupo. Atualiza a cada 30 s. */
export default function Cameras() {
  const { api } = useAuth();
  const [cams, setCams] = useState<Camera[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      // A API entrega até 100 por página.
      const all: Camera[] = [];
      for (let page = 1; page <= 20; page++) {
        const r = await api.get<{ items: Camera[]; total: number }>(
          `/api/v1/cameras?pageSize=100&page=${page}`,
        );
        all.push(...r.items);
        if (r.items.length < 100 || all.length >= r.total) break;
      }
      setCams(all.filter((c) => c.enabled));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Falha ao carregar as câmeras");
    }
  }, [api]);

  useFocusEffect(
    useCallback(() => {
      void load();
      const t = setInterval(load, 30_000);
      return () => clearInterval(t);
    }, [load]),
  );

  const tree = useMemo(() => buildTree(cams ?? []), [cams]);

  if (!cams && !error)
    return (
      <Center>
        <Text style={{ color: colors.muted }}>Carregando câmeras…</Text>
      </Center>
    );

  return (
    <ScrollView
      contentContainerStyle={st.wrap}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            setRefreshing(false);
          }}
        />
      }
    >
      <ErrorText>{error}</ErrorText>
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
              <Card key={g.key}>
                <View style={st.groupHead}>
                  <Text style={st.groupTitle}>{g.title}</Text>
                  {online.length >= 2 && (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Mosaico de ${g.title}`}
                      style={st.mosaicBtn}
                      onPress={() =>
                        router.push({
                          pathname: "/mosaico",
                          params: { ids: online.map((c) => c.id).join(","), title: g.title },
                        })
                      }
                    >
                      <Ionicons name="grid" size={14} color={colors.primary} />
                      <Text style={st.mosaicText}>Mosaico</Text>
                    </Pressable>
                  )}
                </View>
                {g.cameras.map((c, i) => (
                  <Pressable
                    key={c.id}
                    testID="camera-row"
                    accessibilityRole="button"
                    accessibilityLabel={`${c.name}, ${c.code}`}
                    onPress={() =>
                      router.push({ pathname: "/camera/[id]", params: { id: c.id, name: c.name } })
                    }
                    style={({ pressed }) => [
                      st.row,
                      i > 0 && st.rowLine,
                      pressed && { backgroundColor: "#f8fafc" },
                    ]}
                  >
                    <View style={st.thumb}>
                      <Ionicons
                        name="videocam"
                        size={20}
                        color={isOnline(c.status) ? colors.primary : colors.muted}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={st.name} numberOfLines={1}>
                        {c.name}
                      </Text>
                      <Text style={st.code}>{c.code}</Text>
                    </View>
                    <StatusBadge status={c.status} />
                    <Ionicons name="chevron-forward" size={18} color="#94a3b8" />
                  </Pressable>
                ))}
              </Card>
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
  secHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  secTitle: { fontSize: 16, fontWeight: "700", color: colors.ink },
  groupHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: "#f8fafc",
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
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
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  rowLine: { borderTopWidth: 1, borderTopColor: colors.line },
  thumb: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: "#eef4ff",
    alignItems: "center",
    justifyContent: "center",
  },
  name: { fontSize: 16, fontWeight: "600", color: colors.ink },
  code: { fontSize: 12, color: colors.muted },
});
