import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useEffect, useState } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import { useAuth } from "../lib/auth";
import { readJson, writeJson } from "../lib/local-json";
import { colors } from "../lib/theme";

/**
 * Foto da câmera: a do servidor (renovada a cada 5 min enquanto a câmera está no ar) e,
 * enquanto ela carrega ou sem internet, a última que este celular já baixou.
 */
const BUCKET_MS = 5 * 60_000;
const lastKeys: Record<string, string> = readJson("thumbs", {});

/** Janela de 5 min atual (troca sozinha: a foto nova é pedida na janela seguinte). */
function useBucket() {
  const [b, setB] = useState(() => Math.floor(Date.now() / BUCKET_MS));
  useEffect(() => {
    const t = setInterval(() => setB(Math.floor(Date.now() / BUCKET_MS)), 30_000);
    return () => clearInterval(t);
  }, []);
  return b;
}

export function CameraThumb({ cameraId, style }: { cameraId: string; style?: ViewStyle }) {
  const { api } = useAuth();
  const [failed, setFailed] = useState(false);
  const bucket = useBucket();
  const key = `cam-${cameraId}-${bucket}`;
  const last = lastKeys[cameraId];
  const uri = api.url(`/api/v1/cameras/${cameraId}/snapshot`);
  return (
    <View style={[st.box, style]}>
      {!failed || last ? (
        <Image
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          cachePolicy="disk"
          transition={150}
          source={
            failed ? { uri, cacheKey: last } : { uri, headers: api.authHeaders(), cacheKey: key }
          }
          placeholder={last && last !== key ? { uri, cacheKey: last } : undefined}
          placeholderContentFit="cover"
          onLoad={() => {
            if (!failed && lastKeys[cameraId] !== key) {
              lastKeys[cameraId] = key;
              writeJson("thumbs", lastKeys);
            }
          }}
          onError={() => setFailed(true)}
          accessibilityIgnoresInvertColors
        />
      ) : (
        <Ionicons name="videocam" size={22} color={colors.muted} />
      )}
    </View>
  );
}

const st = StyleSheet.create({
  box: {
    backgroundColor: "#e2e8f0",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
});
