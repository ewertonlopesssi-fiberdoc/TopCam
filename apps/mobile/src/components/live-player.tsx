import { Ionicons } from "@expo/vector-icons";
import { useEvent } from "expo";
import { VideoView, useVideoPlayer, type VideoPlayer } from "expo-video";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { WEBRTC_AUDIO, type WhepMsg } from "../lib/whep-page";
import { WebrtcView } from "./webrtc-view";

/**
 * Ao vivo. Pede à API um endereço temporário (token de 2 h, ligado ao usuário e à sessão).
 *
 * - Sem som: WebRTC (~1 s de atraso, como no painel), numa WebView.
 * - Com som: HLS no player nativo (2 a 6 s), porque o WebRTC não leva o áudio AAC das câmeras.
 *   Se o áudio da câmera for Opus/G.711, o som também vai pelo WebRTC.
 * - Se o WebRTC falhar (rede que bloqueia, sem imagem em 10 s), cai para HLS sozinho.
 * Se o endereço falhar ou vencer, "Tentar de novo" pede outro.
 */

interface LiveItem {
  cameraId: string;
  ok: boolean;
  hls?: string;
  whep?: string;
  audioCodec?: string | null;
  error?: string;
  message?: string;
  warnings?: string[];
}

interface LiveState {
  url: string | null;
  whep: string | null;
  audioCodec: string | null;
  problem: string | null;
  warnings: string[];
}
const EMPTY: LiveState = { url: null, whep: null, audioCodec: null, problem: null, warnings: [] };

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
        else
          setState({
            url: api.url(it.hls),
            whep: it.whep ? api.url(it.whep) : null,
            audioCodec: it.audioCodec ?? null,
            problem: null,
            warnings: it.warnings ?? [],
          });
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
  return { ...state, reload, attempt, base: api.url("/") };
}

export type LiveTech = "webrtc" | "hls";

/** Fora do componente: o player do expo-video é configurado por propriedades. */
function applyMuted(p: VideoPlayer, muted: boolean) {
  p.muted = muted;
}
function startPlayer(p: VideoPlayer, muted: boolean) {
  p.muted = muted;
  p.play();
}

export function LivePlayer({
  cameraId,
  compact,
  muted = true,
  onPress,
  fullscreenRef,
  onTech,
}: {
  cameraId: string;
  /** Mosaico: sem textos longos. */
  compact?: boolean;
  muted?: boolean;
  onPress?: () => void;
  fullscreenRef?: React.MutableRefObject<(() => void) | null>;
  /** Avisa qual transmissão está em uso (para o texto de atraso da tela). */
  onTech?: (tech: LiveTech, latency: number | null) => void;
}) {
  const { url, whep, audioCodec, problem, warnings, reload, attempt, base } = useLiveUrl(cameraId);
  // WebRTC falhou neste endereço: fica no HLS até "Tentar de novo".
  const [rtcFailed, setRtcFailed] = useState<number | null>(null);
  const [rtc, setRtc] = useState<{ playing: boolean; latency: number | null }>({
    playing: false,
    latency: null,
  });
  const rtcAudio = WEBRTC_AUDIO.has((audioCodec ?? "").toLowerCase());
  const tech: LiveTech | null = !url
    ? null
    : whep && rtcFailed !== attempt && (muted || rtcAudio)
      ? "webrtc"
      : "hls";

  const player = useVideoPlayer(
    tech === "hls" && url ? { uri: url, contentType: "hls" } : null,
    (p) => {
      p.muted = muted;
      p.play();
    },
  );
  const { status } = useEvent(player, "statusChange", { status: player.status });
  const view = useRef<VideoView>(null);
  const hlsFull = useRef<(() => void) | null>(null);
  const rtcFull = useRef<(() => void) | null>(null);

  useEffect(() => {
    applyMuted(player, muted);
  }, [muted, player]);
  // Ao trocar para HLS (ligar o som ou WebRTC falhou), o player recebe a fonte agora: toca.
  const hlsOn = tech === "hls" && Boolean(url);
  useEffect(() => {
    if (hlsOn && status === "readyToPlay" && !player.playing) startPlayer(player, muted);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- só ao ficar pronto
  }, [hlsOn, status, player]);
  useEffect(() => {
    hlsFull.current = () => void view.current?.enterFullscreen();
  }, []);
  useEffect(() => {
    if (fullscreenRef)
      fullscreenRef.current = () => (tech === "webrtc" ? rtcFull.current?.() : hlsFull.current?.());
  }, [fullscreenRef, tech]);
  useEffect(() => {
    if (tech) onTech?.(tech, tech === "webrtc" ? rtc.latency : null);
  }, [tech, rtc.latency, onTech]);

  const onRtc = useCallback(
    (m: WhepMsg) => {
      if (m.t === "latency") setRtc((r) => ({ ...r, latency: m.v }));
      else if (m.s === "connecting") setRtc({ playing: false, latency: null });
      else if (m.s === "playing") setRtc((r) => ({ ...r, playing: true }));
      else if (m.s === "error") {
        setRtc({ playing: false, latency: null });
        setRtcFailed(attempt);
      }
    },
    [attempt],
  );

  const ready = tech === "webrtc" ? rtc.playing : status === "readyToPlay";
  // O erro do player é técnico (ex.: código do decodificador): mostra uma frase simples.
  const failed =
    problem ??
    (tech === "hls" && status === "error" ? "Não foi possível tocar o vídeo agora." : null);
  return (
    <View style={st.box} testID={`live-${cameraId}`}>
      {tech === "webrtc" && whep && (
        <WebrtcView
          key={`${whep}-${attempt}`}
          url={whep}
          baseUrl={base}
          muted={muted}
          onMessage={onRtc}
          fullscreenRef={rtcFull}
        />
      )}
      {tech === "hls" && (
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
          <Pressable
            onPress={() => {
              setRtc({ playing: false, latency: null });
              reload();
            }}
            style={st.retry}
            accessibilityRole="button"
          >
            <Text style={st.retryText}>Tentar de novo</Text>
          </Pressable>
        </View>
      ) : (
        !ready && (
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
      {/* Toque por cima do vídeo: no Android a área nativa do player engole o toque. */}
      {onPress && !failed && (
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel="Ampliar câmera"
          testID={`tap-${cameraId}`}
        />
      )}
    </View>
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
