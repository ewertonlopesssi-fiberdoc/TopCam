"use client";

import { Expand, Loader2, Pause, Play, RotateCcw, RotateCw, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { api } from "@/lib/api";
import { fmtClock, msToZoned } from "@/lib/format";

/**
 * Player das gravações.
 *
 * O servidor de reprodução entrega um fMP4 contínuo a partir de `start` com `duration`
 * segundos, sem suporte a Range. Por isso o player trabalha em trechos:
 *  - cada trecho vai do ponto pedido até o fim do bloco contínuo (máx. CHUNK_S);
 *  - ao terminar, emenda o próximo trecho do mesmo bloco ou pula para o próximo bloco
 *    (as lacunas são saltadas);
 *  - "ir para" (linha do tempo, ±10 s, Buscar) carrega um trecho novo a partir do ponto.
 * O horário absoluto = início do trecho + currentTime.
 */

export interface Span {
  from: number; // ms
  to: number; // ms
}

export interface RecordingPlayerHandle {
  seek: (ms: number) => void;
}

const CHUNK_S = 900;
export const SPEEDS = [0.5, 1, 2, 4, 8] as const;

interface PlaybackGrant {
  url: string;
  expiresAt: string;
}

export function RecordingPlayer({
  cameraId,
  label,
  spans,
  onTime,
  handle,
}: {
  cameraId: string;
  label: string;
  spans: Span[];
  onTime: (ms: number | null) => void;
  handle: Ref<RecordingPlayerHandle>;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const grant = useRef<{ camera: string; g: PlaybackGrant } | null>(null);
  const chunk = useRef<{ start: number; end: number } | null>(null);
  const spansRef = useRef(spans);
  spansRef.current = spans;
  const [now, setNow] = useState<number | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "playing" | "paused" | "end" | "error">(
    "idle",
  );
  const [message, setMessage] = useState("");
  const [rate, setRate] = useState(1);
  const rateRef = useRef(1);
  const [muted, setMuted] = useState(true);

  const getGrant = useCallback(async () => {
    const cur = grant.current;
    if (cur && cur.camera === cameraId && Date.parse(cur.g.expiresAt) - Date.now() > 60_000)
      return cur.g;
    const g = await api.post<PlaybackGrant>(`/cameras/${cameraId}/playback`);
    grant.current = { camera: cameraId, g };
    return g;
  }, [cameraId]);

  const load = useCallback(
    async (at: number) => {
      const v = video.current;
      if (!v) return;
      const list = spansRef.current;
      // Bloco que contém o ponto ou, numa lacuna, o próximo bloco.
      const span =
        list.find((s) => at >= s.from && at < s.to - 500) ?? list.find((s) => s.from > at);
      if (!span) {
        chunk.current = null;
        v.removeAttribute("src");
        v.load();
        setState("end");
        setMessage("Sem gravação a partir deste ponto.");
        return;
      }
      // +5 ms: o banco guarda o início em ms e o arquivo começa até 1 ms depois.
      const start = Math.max(at, span.from + 5);
      const end = Math.min(span.to, start + CHUNK_S * 1000);
      const duration = Math.max(1, Math.ceil((end - start) / 1000));
      setState("loading");
      setMessage("");
      try {
        const g = await getGrant();
        chunk.current = { start, end };
        setNow(start);
        onTime(start);
        v.src = `${g.url}&start=${encodeURIComponent(new Date(start).toISOString())}&duration=${duration}`;
        v.defaultPlaybackRate = rateRef.current;
        v.playbackRate = rateRef.current;
        await v.play().catch(() => setState("paused"));
      } catch (err) {
        setState("error");
        setMessage(
          (err as { status?: number }).status === 404
            ? "Você não tem permissão para reproduzir esta câmera."
            : "Não foi possível abrir a gravação.",
        );
      }
    },
    [getGrant, onTime],
  );

  useImperativeHandle(handle, () => ({ seek: (ms) => void load(ms) }), [load]);

  // Troca de câmera: para tudo.
  useEffect(() => {
    const v = video.current;
    chunk.current = null;
    setNow(null);
    setState("idle");
    setMessage("");
    if (v) {
      v.removeAttribute("src");
      v.load();
    }
  }, [cameraId]);

  function onTimeUpdate() {
    const v = video.current;
    const c = chunk.current;
    if (!v || !c) return;
    const t = c.start + v.currentTime * 1000;
    setNow(t);
    onTime(t);
  }

  function onEnded() {
    const c = chunk.current;
    const v = video.current;
    if (!c || !v) return;
    const reached = c.start + v.currentTime * 1000;
    if (reached >= c.end - 2000) return void load(c.end);
    // Terminou antes do previsto (o servidor para numa interrupção da gravação):
    // segue para o próximo bloco depois do ponto alcançado.
    const next = spansRef.current.find((s) => s.from > reached + 500);
    void load(next ? next.from : c.end);
  }

  function onError() {
    if (!chunk.current) return;
    setState("error");
    setMessage("Não foi possível reproduzir este trecho.");
  }

  function toggle() {
    const v = video.current;
    if (!v) return;
    if (!chunk.current) {
      const first = spansRef.current[0];
      if (first) void load(first.from);
      return;
    }
    if (v.paused) void v.play();
    else v.pause();
  }

  function jump(deltaS: number) {
    if (now === null) return;
    void load(now + deltaS * 1000);
  }

  function changeRate(r: number) {
    rateRef.current = r;
    setRate(r);
    const v = video.current;
    if (v) {
      v.defaultPlaybackRate = r;
      v.playbackRate = r;
    }
  }

  const busy = state === "loading";
  return (
    <div
      ref={box}
      className="relative overflow-hidden rounded-lg bg-black"
      data-testid="recording-player"
      data-state={state}
    >
      <div className="relative aspect-video w-full">
        <video
          ref={video}
          className="h-full w-full bg-black object-contain"
          playsInline
          muted={muted}
          onTimeUpdate={onTimeUpdate}
          onEnded={onEnded}
          onError={onError}
          onPlaying={() => setState("playing")}
          onPause={() => chunk.current && setState((s) => (s === "loading" ? s : "paused"))}
          onWaiting={() => setState("loading")}
          onClick={toggle}
        />
        <div className="pointer-events-none absolute left-2 top-2 rounded bg-black/60 px-2 py-1 text-xs font-medium text-white">
          {label}
        </div>
        {now !== null && (
          <div
            className="pointer-events-none absolute right-2 top-2 rounded bg-black/60 px-2 py-1 font-mono text-xs text-white"
            data-testid="player-clock"
            data-ms={Math.round(now)}
          >
            {msToZoned(now).slice(0, 10).split("-").reverse().join("/")} {fmtClock(now)}
          </div>
        )}
        {(busy || message || state === "idle") && (
          <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-slate-200">
            {busy ? (
              <Loader2 className="animate-spin" size={28} />
            ) : message ? (
              <span className="rounded bg-black/60 px-3 py-2">{message}</span>
            ) : (
              <button
                className="flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 hover:bg-white/20"
                onClick={toggle}
                disabled={!spans.length}
              >
                <Play size={18} /> {spans.length ? "Reproduzir" : "Sem gravação neste dia"}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1 bg-slate-900 px-2 py-1.5 text-slate-200">
        <button
          className="player-btn"
          onClick={() => jump(-10)}
          aria-label="Voltar 10 segundos"
          disabled={now === null}
        >
          <RotateCcw size={16} />
        </button>
        <button
          className="player-btn"
          onClick={toggle}
          aria-label={state === "playing" ? "Pausar" : "Reproduzir"}
        >
          {state === "playing" ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <button
          className="player-btn"
          onClick={() => jump(10)}
          aria-label="Avançar 10 segundos"
          disabled={now === null}
        >
          <RotateCw size={16} />
        </button>
        <div
          className="ml-1 flex overflow-hidden rounded border border-white/15"
          role="group"
          aria-label="Velocidade"
        >
          {SPEEDS.map((s) => (
            <button
              key={s}
              className={`px-2 py-1 text-xs ${rate === s ? "bg-brand-600 text-white" : "hover:bg-white/10"}`}
              onClick={() => changeRate(s)}
              aria-pressed={rate === s}
            >
              {String(s).replace(".", ",")}x
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <button
            className="player-btn"
            onClick={() => setMuted((m) => !m)}
            aria-label={muted ? "Ativar som" : "Desativar som"}
          >
            {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>
          <button
            className="player-btn"
            onClick={() => void box.current?.requestFullscreen()}
            aria-label="Tela cheia"
          >
            <Expand size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
