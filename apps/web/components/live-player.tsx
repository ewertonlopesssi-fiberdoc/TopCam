"use client";

import type Hls from "hls.js";
import {
  Camera as CameraIcon,
  Loader2,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  Volume2,
  VolumeX,
  WifiOff,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

export type LiveMode = "auto" | "webrtc" | "hls";

export interface LiveSession {
  cameraId: string;
  ok: boolean;
  error?: string;
  message?: string;
  code?: string;
  name?: string;
  status?: string;
  videoCodec?: string | null;
  audioCodec?: string | null;
  hls?: string;
  whep?: string;
  expiresAt?: string;
  warnings?: string[];
}

export interface LiveCameraInfo {
  id: string;
  code: string;
  name: string;
  status: string;
  lastVideoAt: string | null;
  audioCodec: string | null;
}

/** Estados em que há vídeo chegando ao servidor (vale a pena tentar tocar). */
const RECEIVING = new Set(["recebendo", "validando", "ao_vivo", "gravando"]);

type PlayState = "idle" | "connecting" | "playing" | "offline" | "error";
type Tech = "webrtc" | "hls" | "native";

/** Diferença entre o relógio NTP (RTCP) e o epoch do JavaScript. */
const NTP_EPOCH_OFFSET_MS = 2208988800000;

// ------------------------------------------------------------------ WebRTC (WHEP)
async function startWhep(
  url: string,
  video: HTMLVideoElement,
  signal: AbortSignal,
): Promise<RTCPeerConnection> {
  const pc = new RTCPeerConnection({ bundlePolicy: "max-bundle" });
  signal.addEventListener("abort", () => pc.close());
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });
  const stream = new MediaStream();
  pc.ontrack = (ev) => {
    stream.addTrack(ev.track);
    if (video.srcObject !== stream) video.srcObject = stream;
  };
  await pc.setLocalDescription(await pc.createOffer());
  // Oferta completa (sem trickle): espera a coleta de candidatos por até 1,5 s.
  await new Promise<void>((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    const t = setTimeout(resolve, 1500);
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(t);
        resolve();
      }
    });
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/sdp" },
    body: pc.localDescription!.sdp,
    signal,
    credentials: "omit",
  });
  if (res.status !== 201) throw new Error(`WHEP ${res.status}`);
  await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
  // Conexão de mídia estabelecida em até 8 s (UDP/TCP 8189).
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("WebRTC sem conexão de mídia")), 8000);
    const check = () => {
      if (pc.connectionState === "connected") {
        clearTimeout(t);
        resolve();
      } else if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        clearTimeout(t);
        reject(new Error(`WebRTC ${pc.connectionState}`));
      }
    };
    pc.addEventListener("connectionstatechange", check);
    check();
  });
  return pc;
}

async function webrtcLatency(pc: RTCPeerConnection): Promise<number | null> {
  const stats = await pc.getStats();
  let latency: number | null = null;
  stats.forEach((s) => {
    if (s.type !== "inbound-rtp" || s.kind !== "video") return;
    const r = s as RTCInboundRtpStreamStats & { estimatedPlayoutTimestamp?: number };
    if (r.estimatedPlayoutTimestamp) {
      const l = (Date.now() + NTP_EPOCH_OFFSET_MS - r.estimatedPlayoutTimestamp) / 1000;
      if (l > 0 && l < 60) latency = l;
    }
  });
  return latency;
}

// ------------------------------------------------------------------ componente
export function LivePlayer({
  camera,
  session,
  mode,
  onRenew,
  onFocus,
  showLatency = true,
}: {
  camera: LiveCameraInfo;
  session: LiveSession | undefined;
  mode: LiveMode;
  /** Pede um endereço novo (expirou, foi recusado ou a câmera voltou). */
  onRenew: (cameraId: string) => void;
  onFocus?: (cameraId: string) => void;
  showLatency?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<PlayState>("idle");
  const [tech, setTech] = useState<Tech | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [muted, setMuted] = useState(true);
  const [paused, setPaused] = useState(false);
  const [full, setFull] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const hlsRef = useRef<Hls | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);

  const receiving = RECEIVING.has(camera.status);
  const hasAudio = Boolean(camera.audioCodec);

  // ---- início e reconexão
  useEffect(() => {
    const v = video.current;
    if (!v || !session?.ok || !session.hls || !session.whep) return;
    if (!receiving) {
      setState("offline");
      return;
    }
    const ctrl = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    const fail = (why: string) => {
      if (ctrl.signal.aborted) return;
      setState("error");
      console.debug(`[ao vivo] ${camera.code}: ${why}`);
      // Novo endereço e nova tentativa (backoff até 15 s).
      retry = setTimeout(() => onRenew(camera.id), Math.min(15000, 3000 * (attempt + 1)));
    };
    setState("connecting");
    setLatency(null);
    setPaused(false);

    const playHls = async () => {
      const { default: HlsLib } = await import("hls.js");
      if (ctrl.signal.aborted) return;
      if (HlsLib.isSupported()) {
        const hls = new HlsLib({
          lowLatencyMode: true,
          backBufferLength: 10,
          liveDurationInfinity: true,
          manifestLoadingMaxRetry: 2,
          levelLoadingMaxRetry: 2,
        });
        hlsRef.current = hls;
        ctrl.signal.addEventListener("abort", () => hls.destroy());
        hls.on(HlsLib.Events.ERROR, (_e, data) => {
          if (data.fatal) fail(`HLS ${data.type} ${data.details} ${data.response?.code ?? ""}`);
        });
        hls.loadSource(session.hls!);
        hls.attachMedia(v);
        setTech("hls");
      } else if (v.canPlayType("application/vnd.apple.mpegurl")) {
        // Safari/iOS: HLS nativo.
        v.src = session.hls!;
        ctrl.signal.addEventListener("abort", () => {
          v.removeAttribute("src");
          v.load();
        });
        v.onerror = () => fail("HLS nativo");
        setTech("native");
      } else {
        fail("navegador sem suporte a HLS");
        return;
      }
      v.play().catch(() => undefined);
    };

    (async () => {
      if (mode !== "hls" && typeof RTCPeerConnection !== "undefined") {
        try {
          const pc = await startWhep(session.whep!, v, ctrl.signal);
          if (ctrl.signal.aborted) return;
          pcRef.current = pc;
          setTech("webrtc");
          pc.addEventListener("connectionstatechange", () => {
            if (pc.connectionState === "failed" || pc.connectionState === "disconnected")
              fail(`WebRTC ${pc.connectionState}`);
          });
          v.play().catch(() => undefined);
          return;
        } catch (err) {
          if (ctrl.signal.aborted) return;
          v.srcObject = null;
          if (mode === "webrtc") return fail((err as Error).message);
          console.debug(`[ao vivo] ${camera.code}: WebRTC indisponível, usando HLS`, err);
        }
      }
      await playHls();
    })().catch((err) => fail((err as Error).message));

    return () => {
      ctrl.abort();
      clearTimeout(retry);
      hlsRef.current = null;
      pcRef.current = null;
      v.srcObject = null;
      setTech(null);
    };
    // "attempt" força uma nova tentativa com o mesmo endereço.
  }, [session?.hls, session?.whep, session?.ok, mode, receiving, attempt]);

  // ---- vídeo tocando
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const onPlaying = () => setState("playing");
    v.addEventListener("playing", onPlaying);
    return () => v.removeEventListener("playing", onPlaying);
  }, []);

  // ---- latência medida (HLS: data/hora do programa; WebRTC: estatísticas RTCP)
  useEffect(() => {
    if (state !== "playing") return;
    const t = setInterval(async () => {
      if (tech === "webrtc" && pcRef.current) setLatency(await webrtcLatency(pcRef.current));
      else if (tech === "hls" && hlsRef.current?.playingDate)
        setLatency((Date.now() - hlsRef.current.playingDate.getTime()) / 1000);
    }, 2000);
    return () => clearInterval(t);
  }, [state, tech]);

  // ---- endereço perto de vencer: renova (HLS; no WebRTC a sessão aberta continua)
  useEffect(() => {
    if (!session?.expiresAt || tech === "webrtc") return;
    const ms = new Date(session.expiresAt).getTime() - Date.now() - 60_000;
    const t = setTimeout(() => onRenew(camera.id), Math.max(5_000, ms));
    return () => clearTimeout(t);
  }, [session?.expiresAt, tech, camera.id, onRenew]);

  useEffect(() => {
    const onFs = () => setFull(document.fullscreenElement === box.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const togglePause = useCallback(() => {
    const v = video.current;
    if (!v) return;
    if (v.paused) {
      // Ao retomar, volta para o ponto ao vivo.
      if (hlsRef.current?.liveSyncPosition) v.currentTime = hlsRef.current.liveSyncPosition;
      void v.play();
      setPaused(false);
    } else {
      v.pause();
      setPaused(true);
    }
  }, []);

  const snapshot = useCallback(() => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext("2d")!.drawImage(v, 0, 0);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    c.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${camera.code}_${stamp}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, "image/png");
  }, [camera.code]);

  const toggleFull = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void box.current?.requestFullscreen();
  }, []);

  const denied = session && !session.ok;
  const label =
    state === "playing" ? (paused ? "PAUSADO" : "AO VIVO") : state === "offline" ? "OFFLINE" : null;

  return (
    <div
      ref={box}
      className="group relative flex aspect-video min-w-0 items-center justify-center overflow-hidden rounded-lg bg-slate-950 text-white"
      data-testid="live-tile"
      data-camera={camera.code}
      data-state={denied ? "denied" : state}
      data-tech={tech ?? ""}
      data-latency={latency ?? ""}
      onDoubleClick={() => onFocus?.(camera.id)}
    >
      <video
        ref={video}
        className="h-full w-full object-contain"
        muted={muted}
        playsInline
        autoPlay
        aria-label={`Ao vivo ${camera.code} - ${camera.name}`}
      />

      {/* título */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center gap-2 bg-gradient-to-b from-black/70 to-transparent px-2.5 py-1.5 text-xs font-medium">
        <span className="truncate">
          {camera.code} - {camera.name}
        </span>
      </div>

      {/* estados */}
      {denied ? (
        <Overlay icon={<WifiOff size={28} />} text={session!.message ?? "Sem acesso ao vivo"} />
      ) : state === "offline" ? (
        <Overlay
          icon={<WifiOff size={28} />}
          text="Câmera sem sinal"
          sub={
            camera.lastVideoAt
              ? `Último vídeo: ${new Date(camera.lastVideoAt).toLocaleString("pt-BR")}`
              : "Aguardando a primeira transmissão"
          }
        />
      ) : state === "connecting" || state === "idle" ? (
        <Overlay icon={<Loader2 size={26} className="animate-spin" />} text="Conectando…" />
      ) : state === "error" ? (
        <Overlay
          icon={<Loader2 size={26} className="animate-spin" />}
          text="Reconectando…"
          action={
            <button
              className="mt-2 rounded bg-white/15 px-2 py-1 text-xs hover:bg-white/25"
              onClick={() => setAttempt((n) => n + 1)}
            >
              Tentar agora
            </button>
          }
        />
      ) : null}

      {session?.warnings?.length ? (
        <div className="absolute inset-x-2 top-8 z-10 rounded bg-amber-500/90 px-2 py-1 text-[11px] leading-snug text-black">
          {session.warnings[0]}
        </div>
      ) : null}

      {/* rodapé com controles */}
      <div className="absolute inset-x-0 bottom-0 z-10 flex items-center gap-1 bg-gradient-to-t from-black/80 to-transparent px-1.5 pt-4 pb-1.5">
        <CtrlButton
          label={paused ? "Retomar" : "Pausar"}
          onClick={togglePause}
          disabled={state !== "playing"}
        >
          {paused ? <Play size={15} /> : <Pause size={15} />}
        </CtrlButton>
        <CtrlButton
          label={muted ? "Ativar som" : "Silenciar"}
          onClick={() => setMuted((m) => !m)}
          disabled={!hasAudio || state !== "playing"}
        >
          {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
        </CtrlButton>
        <CtrlButton label="Capturar imagem" onClick={snapshot} disabled={state !== "playing"}>
          <CameraIcon size={15} />
        </CtrlButton>
        {showLatency && state === "playing" && tech && (
          <span
            className="ml-1 hidden text-[10px] text-white/70 sm:inline"
            data-testid="live-latency"
          >
            {tech === "webrtc" ? "WebRTC" : "HLS"}
            {latency !== null ? ` · ${latency.toFixed(1).replace(".", ",")} s` : ""}
          </span>
        )}
        <span className="ml-auto" />
        {label && (
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide ${
              label === "AO VIVO" ? "bg-red-600" : "bg-slate-600"
            }`}
          >
            {label}
          </span>
        )}
        <CtrlButton label={full ? "Sair da tela cheia" : "Tela cheia"} onClick={toggleFull}>
          {full ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </CtrlButton>
      </div>
    </div>
  );
}

function Overlay({
  icon,
  text,
  sub,
  action,
}: {
  icon: React.ReactNode;
  text: string;
  sub?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-950/85 px-3 text-center">
      <div className="text-slate-400">{icon}</div>
      <div className="mt-2 text-sm font-medium">{text}</div>
      {sub && <div className="mt-0.5 text-[11px] text-slate-400">{sub}</div>}
      {action}
    </div>
  );
}

function CtrlButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="flex h-7 w-7 items-center justify-center rounded text-white/90 hover:bg-white/15 disabled:opacity-40"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}
