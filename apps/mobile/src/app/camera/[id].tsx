import { Ionicons } from "@expo/vector-icons";
import { Stack, router, useIsFocused, useLocalSearchParams } from "expo-router";
import { useAuth } from "../../lib/auth";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { LivePlayer, type LiveTech } from "../../components/live-player";
import { colors } from "../../lib/theme";

/** Ao vivo de uma câmera. Deitar o celular ou o botão de tela cheia amplia o vídeo. */
export default function CameraLive() {
  const { id, name, rec } = useLocalSearchParams<{ id: string; name?: string; rec?: string }>();
  const [muted, setMuted] = useState(true);
  const [tech, setTech] = useState<{ tech: LiveTech; latency: number | null } | null>(null);
  const onTech = useCallback(
    (t: LiveTech, latency: number | null) => setTech({ tech: t, latency }),
    [],
  );
  const full = useRef<(() => void) | null>(null);
  const { width, height } = useWindowDimensions();
  const landscape = width > height;
  // Com as gravações abertas por cima, o ao vivo para.
  const focused = useIsFocused();
  const { api } = useAuth();
  // Botão "Gravações": aparece já se a câmera grava (vem da lista) e some só se a API
  // disser que o usuário não pode reproduzir (404). Erro de rede não esconde o botão.
  const [canPlay, setCanPlay] = useState(rec === "1");
  useEffect(() => {
    api
      .get<{ recordingEnabled: boolean; segments: number }>(
        `/api/v1/cameras/${id}/recordings/summary`,
      )
      .then((s) => setCanPlay(s.recordingEnabled || s.segments > 0))
      .catch((e) => {
        if ((e as { status?: number }).status === 404) setCanPlay(false);
      });
  }, [api, id]);

  return (
    <View style={{ flex: 1, backgroundColor: landscape ? "#000" : colors.bg }}>
      <Stack.Screen options={{ title: name ?? "Ao vivo", headerShown: !landscape }} />
      <View style={landscape ? { flex: 1 } : { width, height: (width * 9) / 16 }}>
        {focused && <LivePlayer cameraId={id} muted={muted} fullscreenRef={full} onTech={onTech} />}
      </View>
      {!landscape && (
        <View style={st.bar}>
          <Pressable
            style={st.btn}
            accessibilityRole="button"
            accessibilityLabel={muted ? "Ligar som" : "Desligar som"}
            onPress={() => setMuted((m) => !m)}
          >
            <Ionicons name={muted ? "volume-mute" : "volume-high"} size={22} color={colors.ink} />
            <Text style={st.btnText}>{muted ? "Som desligado" : "Som ligado"}</Text>
          </Pressable>
          <Pressable
            style={st.btn}
            accessibilityRole="button"
            accessibilityLabel="Tela cheia"
            onPress={() => full.current?.()}
          >
            <Ionicons name="expand" size={22} color={colors.ink} />
            <Text style={st.btnText}>Tela cheia</Text>
          </Pressable>
        </View>
      )}
      {!landscape && canPlay && (
        <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
          <Pressable
            style={st.btn}
            accessibilityRole="button"
            accessibilityLabel="Gravações"
            onPress={() =>
              router.push({ pathname: "/gravacoes/[id]", params: { id, name: name ?? "" } })
            }
          >
            <Ionicons name="film" size={22} color={colors.ink} />
            <Text style={st.btnText}>Gravações</Text>
          </Pressable>
        </View>
      )}
      {!landscape && (
        <Text style={st.hint} testID="live-hint">
          {tech?.tech === "webrtc"
            ? `Tempo real${tech.latency !== null ? ` (atraso de ${tech.latency.toFixed(1).replace(".", ",")} s)` : ""}. Com o som ligado, o vídeo pode ficar alguns segundos atrás.`
            : "Ao vivo com alguns segundos de atraso."}{" "}
          Deite o celular para ampliar.
        </Text>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  bar: { flexDirection: "row", gap: 12, padding: 16 },
  btn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    height: 48,
    borderRadius: 10,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: colors.line,
  },
  btnText: { color: colors.ink, fontWeight: "500" },
  hint: { color: colors.muted, fontSize: 12, textAlign: "center", paddingHorizontal: 16 },
});
