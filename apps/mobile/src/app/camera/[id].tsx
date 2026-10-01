import { Ionicons } from "@expo/vector-icons";
import { Stack, useLocalSearchParams } from "expo-router";
import { useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { LivePlayer } from "../../components/live-player";
import { colors } from "../../lib/theme";

/** Ao vivo de uma câmera. Deitar o celular ou o botão de tela cheia amplia o vídeo. */
export default function CameraLive() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const [muted, setMuted] = useState(true);
  const full = useRef<(() => void) | null>(null);
  const { width, height } = useWindowDimensions();
  const landscape = width > height;

  return (
    <View style={{ flex: 1, backgroundColor: landscape ? "#000" : colors.bg }}>
      <Stack.Screen options={{ title: name ?? "Ao vivo", headerShown: !landscape }} />
      <View style={landscape ? { flex: 1 } : { width, height: (width * 9) / 16 }}>
        <LivePlayer cameraId={id} muted={muted} fullscreenRef={full} />
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
      {!landscape && (
        <Text style={st.hint}>
          Ao vivo com 2 a 3 segundos de atraso. Deite o celular para ampliar.
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
