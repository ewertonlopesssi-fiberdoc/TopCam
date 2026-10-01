import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { CameraThumb } from "../../components/camera-thumb";
import { Center, ErrorText } from "../../components/ui";
import { ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { colors } from "../../lib/theme";
import { whenLabel } from "../../lib/time";

/** Movimentos das câmeras do usuário. Tocar abre a gravação no horário (ou o ao vivo). */
interface MotionItem {
  id: string;
  cameraId: string;
  code: string;
  cameraName: string;
  locationName: string;
  kind: string;
  startedAt: string;
  endedAt: string;
  canPlayback: boolean;
  recordingEnabled: boolean;
}

const KIND: Record<string, { label: string; icon: keyof typeof Ionicons.glyphMap }> = {
  human: { label: "Pessoa detectada", icon: "walk" },
  audio: { label: "Som detectado", icon: "volume-high" },
  motion: { label: "Movimento", icon: "pulse" },
};

export default function Alarmes() {
  const { api } = useAuth();
  const [items, setItems] = useState<MotionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [more, setMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (p = 1) => {
      try {
        const r = await api.get<{ items: MotionItem[]; total: number }>(
          `/api/v1/motion-events?pageSize=50&page=${p}`,
        );
        setItems((cur) => (p === 1 ? r.items : [...(cur ?? []), ...r.items]));
        setPage(p);
        setMore(p * 50 < r.total);
        setError(null);
      } catch (e) {
        setItems((cur) => cur ?? []);
        setError(
          e instanceof ApiError && e.status === 404
            ? "Os alarmes aparecem aqui depois da próxima atualização do servidor."
            : e instanceof ApiError
              ? e.message
              : "Falha ao carregar os alarmes",
        );
      }
    },
    [api],
  );

  useFocusEffect(
    useCallback(() => {
      void load(1);
    }, [load]),
  );

  if (!items)
    return (
      <Center>
        <ActivityIndicator />
      </Center>
    );

  return (
    <FlatList
      data={items}
      keyExtractor={(x) => x.id}
      contentContainerStyle={{ padding: 16, gap: 10, flexGrow: 1 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await load(1);
            setRefreshing(false);
          }}
        />
      }
      ListHeaderComponent={<ErrorText>{error}</ErrorText>}
      ListEmptyComponent={
        error ? null : (
          <Center>
            <Ionicons name="notifications-off-outline" size={36} color={colors.muted} />
            <Text style={{ color: colors.muted, textAlign: "center" }}>
              Nenhum alarme. Quando houver movimento numa câmera com detecção ligada, ele aparece
              aqui.
            </Text>
          </Center>
        )
      }
      onEndReached={() => more && void load(page + 1)}
      renderItem={({ item }) => {
        const k = KIND[item.kind] ?? KIND.motion!;
        const rec = item.canPlayback && item.recordingEnabled;
        return (
          <Pressable
            testID="alarm-row"
            accessibilityRole="button"
            accessibilityLabel={`${k.label}, ${item.cameraName}, ${whenLabel(Date.parse(item.startedAt))}`}
            style={({ pressed }) => [st.row, pressed && { opacity: 0.8 }]}
            onPress={() =>
              rec
                ? router.push({
                    pathname: "/gravacoes/[id]",
                    params: {
                      id: item.cameraId,
                      name: item.cameraName,
                      t: String(Date.parse(item.startedAt)),
                    },
                  })
                : router.push({
                    pathname: "/camera/[id]",
                    params: { id: item.cameraId, name: item.cameraName },
                  })
            }
          >
            <CameraThumb cameraId={item.cameraId} style={st.thumb} />
            <View style={{ flex: 1, gap: 2 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Ionicons name={k.icon} size={16} color="#b45309" />
                <Text style={st.kind}>{k.label}</Text>
              </View>
              <Text style={st.cam} numberOfLines={1}>
                {item.cameraName}
              </Text>
              <Text style={st.meta}>
                {item.locationName} · {whenLabel(Date.parse(item.startedAt))}
              </Text>
              <Text style={[st.meta, { color: rec ? colors.primary : colors.muted }]}>
                {rec ? "Ver gravação" : "Ver ao vivo"}
              </Text>
            </View>
          </Pressable>
        );
      }}
    />
  );
}

const st = StyleSheet.create({
  row: {
    flexDirection: "row",
    gap: 12,
    backgroundColor: "#fff",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.line,
    overflow: "hidden",
    paddingRight: 10,
    alignItems: "center",
  },
  thumb: { width: 120, aspectRatio: 16 / 9 },
  kind: { fontSize: 14, fontWeight: "700", color: "#b45309" },
  cam: { fontSize: 15, fontWeight: "600", color: colors.ink },
  meta: { fontSize: 12, color: colors.muted },
});
