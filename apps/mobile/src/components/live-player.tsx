import { Ionicons } from "@expo/vector-icons";
import { useEvent } from "expo";
import { VideoView, useVideoPlayer, type VideoPlayer } from "expo-video";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";

/**
 * Ao vivo por HLS. Pede à API um endereço temporário (token de 2 h, ligado ao usuário e à
 * sessão) e toca no player nativo. Sem som por padrão. Se o endereço falhar ou vencer,
 * "Tentar de novo" pede outro.
 */

interface LiveItem {
  cameraId: string;
  ok: boolean;
  hls?: string;
  error?: string;
  message?: string;
  warnings?: string[];
}

interface LiveState {
  url: string | null;
  problem: string | null;
  warnings: string[];
}
const EMPTY: LiveState = { url: null, problem: null, warnings: [] };

export function useLiveUrl(cameraId: string) {
  const { api } = useAuth();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LiveState>(EMPTY);
  useEffect(() => {
    let alive = true;
    api
      .post<{ items: LiveItem[] }>("/api/v1/live/sessions", { cameraIds: [cameraId] })
      .then((r) => {
        const it = r.items[0];
        if (!alive) return;
        if (!it?.ok || !it.hls)
          setState({ ...EMPTY, problem: it?.message ?? "Câmera indisponível" });
        else setState({ url: api.url(it.hls), problem: null, warnings: it.warnings ?? [] });
      })
      .catch((e) => {
        if (alive)
          setState({
            ...EMPTY,
            problem: e instanceof ApiError ? e.message : "Falha ao abrir o ao vivo",
          });
      });
    return () => {
      alive = false;
    };
  }, [api, cameraId, attempt]);
  const reload = useCallback(() => {
    setState(EMPTY);
    setAttempt((a) => a + 1);
  }, []);
  return { ...state, reload };
}

/** Fora do componente: o player do expo-video é configurado por propriedades. */
function applyMuted(p: VideoPlayer, muted: boolean) {
  p.muted = muted;
}

export function LivePlayer({
  cameraId,
  compact,
  muted = true,
  onPress,
  fullscreenRef,
}: {
  cameraId: string;
  /** Mosaico: sem textos longos. */
  compact?: boolean;
  muted?: boolean;
  onPress?: () => void;
  fullscreenRef?: React.MutableRefObject<(() => void) | null>;
}) {
  const { url, problem, warnings, reload } = useLiveUrl(cameraId);
  const player = useVideoPlayer(url ? { uri: url, contentType: "hls" } : null, (p) => {
    p.muted = muted;
    p.play();
  });
  const { status } = useEvent(player, "statusChange", { status: player.status });
  const view = useRef<VideoView>(null);

  useEffect(() => {
    applyMuted(player, muted);
  }, [muted, player]);
  useEffect(() => {
    if (fullscreenRef) fullscreenRef.current = () => void view.current?.enterFullscreen();
  }, [fullscreenRef]);

  // O erro do player é técnico (ex.: código do decodificador): mostra uma frase simples.
  const failed = problem ?? (status === "error" ? "Não foi possível tocar o vídeo agora." : null);
  return (
    <Pressable style={st.box} onPress={onPress} disabled={!onPress} testID={`live-${cameraId}`}>
      {url && (
        <VideoView
          ref={view}
          player={player}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          nativeControls={false}
          fullscreenOptions={{ enable: true }}
        />
      )}
      {failed ? (
        <View style={st.overlay}>
          <Ionicons name="videocam-off" size={compact ? 22 : 32} color="#cbd5e1" />
          {!compact && <Text style={st.msg}>{failed}</Text>}
          <Pressable onPress={reload} style={st.retry} accessibilityRole="button">
            <Text style={st.retryText}>Tentar de novo</Text>
          </Pressable>
        </View>
      ) : (
        status !== "readyToPlay" && (
          <View style={st.overlay} pointerEvents="none">
            <ActivityIndicator color="#fff" />
            {!compact && <Text style={st.msg}>Conectando…</Text>}
          </View>
        )
      )}
      {!compact && warnings.length > 0 && !failed && (
        <View style={st.warn} pointerEvents="none">
          <Text style={st.warnText} numberOfLines={2}>
            {warnings[0]}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const st = StyleSheet.create({
  box: { flex: 1, backgroundColor: "#000", overflow: "hidden" },
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: 12,
  },
  msg: { color: "#e2e8f0", fontSize: 14, textAlign: "center" },
  retry: {
    borderColor: "#64748b",
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  retryText: { color: "#fff", fontSize: 13 },
  warn: {
    position: "absolute",
    left: 8,
    right: 8,
    bottom: 8,
    backgroundColor: "#00000099",
    borderRadius: 6,
    padding: 6,
  },
  warnText: { color: "#fde68a", fontSize: 11 },
});
