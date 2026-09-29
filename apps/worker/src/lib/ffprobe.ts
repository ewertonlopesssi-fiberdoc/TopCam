import { execFile } from "node:child_process";
import type { ProbeOutput } from "../context.js";

/** Executa ffprobe no stream interno (RTSP/TCP) e retorna os streams detectados. */
export function runFfprobe(url: string, timeoutS: number): Promise<ProbeOutput> {
  const args = [
    "-v",
    "error",
    "-rtsp_transport",
    "tcp",
    "-timeout",
    String(Math.round(timeoutS * 1_000_000)),
    "-analyzeduration",
    "3000000",
    "-probesize",
    "5000000",
    "-show_entries",
    "stream=codec_type,codec_name,profile,width,height,avg_frame_rate,r_frame_rate,sample_rate,channels",
    "-of",
    "json",
    url,
  ];
  return new Promise((resolve, reject) => {
    execFile(
      "ffprobe",
      args,
      { timeout: (timeoutS + 5) * 1000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`ffprobe falhou: ${(stderr || err.message).trim().slice(0, 500)}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as ProbeOutput);
        } catch {
          reject(new Error("ffprobe retornou JSON inválido"));
        }
      },
    );
  });
}

export function parseFrameRate(value: string | undefined): number | null {
  if (!value) return null;
  const [num, den] = value.split("/").map(Number);
  if (!num || !den) return null;
  const fps = num / den;
  return Number.isFinite(fps) && fps > 0 && fps < 1000 ? Math.round(fps * 100) / 100 : null;
}

export interface FileProbe {
  /** Duração da mídia em segundos (null se não foi possível medir). */
  durationS: number | null;
  streams: Array<{ codec_type?: string; codec_name?: string }>;
}

function execJson(args: string[], timeoutS: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffprobe",
      args,
      { timeout: timeoutS * 1000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          // Tempo esgotado costuma indicar disco travado (latência alta no armazenamento):
          // a mensagem diz isso claramente para o diagnóstico nos logs.
          const e = new Error(
            err.killed
              ? `ffprobe: tempo esgotado (${timeoutS} s) — disco lento ou travado?`
              : `ffprobe falhou: ${(stderr || err.message).trim().slice(0, 500)}`,
          );
          // Tempo esgotado é falha transitória (tenta de novo); o resto é arquivo inválido.
          (e as Error & { transient?: boolean }).transient = Boolean(err.killed);
          reject(e);
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error("ffprobe retornou JSON inválido"));
        }
      },
    );
  });
}

/**
 * Confere um segmento gravado (fMP4): codecs e duração. Em fMP4 a duração do
 * contêiner nem sempre vem preenchida; nesse caso mede pelos pacotes de vídeo
 * (do primeiro ao último, somando a duração do último).
 */
export async function probeFile(file: string, timeoutS = 30): Promise<FileProbe> {
  const out = (await execJson(
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_type,codec_name",
      "-of",
      "json",
      file,
    ],
    timeoutS,
  )) as { format?: { duration?: string }; streams?: FileProbe["streams"] };
  let durationS = Number(out.format?.duration);
  if (!Number.isFinite(durationS) || durationS <= 0) {
    const pk = (await execJson(
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "packet=pts_time,duration_time",
        "-of",
        "json",
        file,
      ],
      timeoutS,
    )) as { packets?: Array<{ pts_time?: string; duration_time?: string }> };
    const p = (pk.packets ?? []).filter((x) => Number.isFinite(Number(x.pts_time)));
    if (p.length) {
      const pts = p.map((x) => Number(x.pts_time));
      const last = p[p.length - 1]!;
      durationS = Math.max(...pts) - Math.min(...pts) + (Number(last.duration_time) || 0);
    } else durationS = NaN;
  }
  return {
    durationS: Number.isFinite(durationS) && durationS > 0 ? durationS : null,
    streams: out.streams ?? [],
  };
}
