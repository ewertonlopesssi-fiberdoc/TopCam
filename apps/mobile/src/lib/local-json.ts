import { File, Paths } from "expo-file-system";
import { Platform } from "react-native";

/** JSON pequeno guardado no celular (localStorage na versão web de testes). */
export function readJson<T>(name: string, fallback: T): T {
  try {
    if (Platform.OS === "web") {
      const v = globalThis.localStorage?.getItem(`topcam.${name}`);
      return v ? (JSON.parse(v) as T) : fallback;
    }
    const f = new File(Paths.document, `${name}.json`);
    return f.exists ? (JSON.parse(f.textSync()) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(name: string, value: unknown): void {
  try {
    const text = JSON.stringify(value);
    if (Platform.OS === "web") return void globalThis.localStorage?.setItem(`topcam.${name}`, text);
    const f = new File(Paths.document, `${name}.json`);
    if (!f.exists) f.create();
    f.write(text);
  } catch {
    // sem espaço ou sem permissão: não é essencial
  }
}
