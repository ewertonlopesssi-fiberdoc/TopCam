import { Directory, File, Paths } from "expo-file-system";
import { Platform } from "react-native";
import { readJson, writeJson } from "./local-json";

/** "Meus vídeos": trechos baixados pelo app, guardados no próprio celular. */
export interface SavedVideo {
  file: string; // nome do arquivo em <documentos>/videos
  cameraId: string;
  cameraName: string;
  start: number;
  seconds: number;
  savedAt: number;
}

export const videosSupported = Platform.OS !== "web";

function dir(): Directory {
  const d = new Directory(Paths.document, "videos");
  if (!d.exists) d.create({ intermediates: true });
  return d;
}

export function listVideos(): (SavedVideo & { uri: string; size: number })[] {
  if (!videosSupported) return [];
  const meta = readJson<SavedVideo[]>("videos", []);
  const d = dir();
  return meta
    .map((m) => {
      const f = new File(d, m.file);
      return f.exists ? { ...m, uri: f.uri, size: f.size } : null;
    })
    .filter((x): x is SavedVideo & { uri: string; size: number } => x !== null)
    .sort((a, b) => b.savedAt - a.savedAt);
}

export async function downloadVideo(
  url: string,
  headers: Record<string, string>,
  info: Omit<SavedVideo, "file" | "savedAt">,
  filename: string,
): Promise<SavedVideo & { uri: string }> {
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, "_");
  const target = new File(dir(), safe);
  const f = await File.downloadFileAsync(url, target, { headers, idempotent: true });
  const entry: SavedVideo = { ...info, file: safe, savedAt: Date.now() };
  const meta = readJson<SavedVideo[]>("videos", []).filter((m) => m.file !== safe);
  writeJson("videos", [entry, ...meta]);
  return { ...entry, uri: f.uri };
}

export function deleteVideo(file: string): void {
  const f = new File(dir(), file);
  if (f.exists) f.delete();
  writeJson(
    "videos",
    readJson<SavedVideo[]>("videos", []).filter((m) => m.file !== file),
  );
}
