import type { CameraRow, Pool } from "@topcam/db";
import {
  decryptStreamKey,
  mediaPathForKey,
  parseEncryptionKey,
  type MediaMtxClient,
} from "@topcam/shared";
import type { Logger } from "pino";
import type { WorkerEnv } from "./env.js";
import type { FileProbe } from "./lib/ffprobe.js";

export interface WorkerContext {
  env: WorkerEnv;
  pool: Pool;
  mediamtx: MediaMtxClient;
  log: Logger;
  encKey: Buffer;
  /** Executa ffprobe; injetável nos testes. */
  runProbe: (url: string, timeoutS: number) => Promise<ProbeOutput>;
  /** Confere um arquivo gravado com ffprobe; injetável nos testes. */
  probeFile?: (file: string) => Promise<FileProbe>;
}

export interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
}

export interface ProbeOutput {
  streams?: ProbeStream[];
}

export function makeEncKey(env: WorkerEnv): Buffer {
  return parseEncryptionKey(env.STREAM_KEY_ENC_KEY);
}

/** Caminho no MediaMTX de uma câmera (decifra a chave). */
export function cameraMediaPath(camera: CameraRow, encKey: Buffer): string | null {
  if (!camera.stream_key_enc) return null;
  return mediaPathForKey(decryptStreamKey(camera.stream_key_enc, encKey));
}

/** Remove a chave de mensagens de erro/log. */
export function redact(text: string): string {
  return text
    .replace(/live\/[A-Za-z0-9]{40}/g, "live/<chave>")
    .replace(/\/\/[^@/\s]+@/g, "//<credenciais>@");
}
