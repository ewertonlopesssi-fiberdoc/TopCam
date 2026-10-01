import { spawn, type ChildProcess } from "node:child_process";

/**
 * Detecção de movimento no servidor, para câmeras sem aviso próprio (Mibo, TWG…).
 *
 * Barata de propósito: o ffmpeg decodifica só os quadros-chave (um a cada ~1–2 s, conforme
 * a câmera), reduz para 160×90 em tons de cinza, e aqui comparamos cada quadro com o
 * anterior. Sem transcodificar o vídeo gravado/visto e sem GPU. Limite conhecido: um
 * movimento mais curto que o intervalo entre quadros-chave pode passar despercebido.
 */

export const FRAME_W = 160;
export const FRAME_H = 90;
export const FRAME_BYTES = FRAME_W * FRAME_H;
/** Diferença mínima de um pixel (0–255), já descontada a mudança geral de brilho. */
export const PIXEL_THRESHOLD = 25;
/** Mudança geral de brilho acima disto (ex.: troca dia/noite, IR) não conta como movimento. */
export const GLOBAL_SHIFT_MAX = 45;

/** Fração de pixels que precisa mudar, pela sensibilidade (1 = pouco … 10 = muito sensível). */
export function changedFractionFor(sensitivity: number): number {
  const s = Math.min(10, Math.max(1, Math.round(sensitivity)));
  return 0.12 * Math.pow(0.7, s - 1); // 12% … ~0,5%
}

export function compareFrames(
  prev: Uint8Array,
  cur: Uint8Array,
): { changed: number; shift: number } {
  const n = Math.min(prev.length, cur.length);
  let sp = 0;
  let sc = 0;
  for (let i = 0; i < n; i++) {
    sp += prev[i]!;
    sc += cur[i]!;
  }
  const mp = sp / n;
  const mc = sc / n;
  let changed = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(cur[i]! - mc - (prev[i]! - mp)) > PIXEL_THRESHOLD) changed++;
  }
  return { changed: changed / n, shift: Math.abs(mc - mp) };
}

export function isMotion(prev: Uint8Array, cur: Uint8Array, sensitivity: number): boolean {
  const r = compareFrames(prev, cur);
  return r.shift <= GLOBAL_SHIFT_MAX && r.changed >= changedFractionFor(sensitivity);
}

/** Junta os pedaços da saída do ffmpeg em quadros inteiros de FRAME_BYTES. */
export class FrameAssembler {
  private buf: Buffer = Buffer.alloc(0);
  push(chunk: Buffer, onFrame: (f: Uint8Array) => void): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= FRAME_BYTES) {
      onFrame(new Uint8Array(this.buf.subarray(0, FRAME_BYTES)));
      this.buf = this.buf.subarray(FRAME_BYTES);
    }
  }
}

export function ffmpegArgs(url: string): string[] {
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    ...(url.startsWith("rtsp://") ? ["-rtsp_transport", "tcp"] : []),
    "-skip_frame",
    "nokey",
    "-i",
    url,
    "-an",
    "-sn",
    "-vf",
    `scale=${FRAME_W}:${FRAME_H}:flags=area,format=gray`,
    "-fps_mode",
    "passthrough",
    "-f",
    "rawvideo",
    "pipe:1",
  ];
}

export interface DetectorHandlers {
  onMotion: (at: Date, intervalMs: number) => void;
  onExit: (code: number | null, stderr: string) => void;
}

/** Um processo ffmpeg por câmera. */
export class CameraDetector {
  private proc: ChildProcess | null = null;
  private prev: Uint8Array | null = null;
  private lastFrameAt = 0;
  sensitivity: number;

  constructor(
    readonly cameraId: string,
    private readonly url: string,
    sensitivity: number,
    private readonly h: DetectorHandlers,
    private readonly ffmpeg = "ffmpeg",
  ) {
    this.sensitivity = sensitivity;
  }

  get running(): boolean {
    return this.proc !== null;
  }

  start(): void {
    const asm = new FrameAssembler();
    let stderr = "";
    const p = spawn(this.ffmpeg, ffmpegArgs(this.url), { stdio: ["ignore", "pipe", "pipe"] });
    this.proc = p;
    p.stdout!.on("data", (chunk: Buffer) => asm.push(chunk, (f) => this.frame(f)));
    p.stderr!.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    p.on("error", (err) => {
      stderr += err.message;
    });
    p.on("close", (code) => {
      this.proc = null;
      this.prev = null;
      this.h.onExit(code, stderr.replace(/rtsp:\/\/[^@\s]*@/g, "rtsp://***@").trim());
    });
  }

  stop(): void {
    this.proc?.kill("SIGTERM");
  }

  /** Exposto para testes: processa um quadro como se viesse do ffmpeg. */
  frame(f: Uint8Array, now = Date.now()): void {
    const interval = this.lastFrameAt ? Math.min(now - this.lastFrameAt, 10_000) : 2000;
    if (this.prev && isMotion(this.prev, f, this.sensitivity))
      this.h.onMotion(new Date(now), interval);
    this.prev = f;
    this.lastFrameAt = now;
  }
}
