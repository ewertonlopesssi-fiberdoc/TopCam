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
