import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import type { ApiClient } from "./api";
import { appVersion } from "./brand";
import { readJson, writeJson } from "./local-json";
import { useSyncExternalStore } from "react";

/**
 * Notificações push dos alarmes. O app pede permissão, pega o endereço de push do celular
 * (serviço da Expo) e registra no servidor, ligado ao usuário e à sessão. Desligar no app
 * avisa o servidor (enabled = false); sair do app encerra a sessão, que deixa de receber.
 */

export const pushSupported = Platform.OS !== "web";
export const ALARM_CHANNEL = "alarmes";

export type PushState =
  | { ok: true; enabled: boolean }
  | {
      ok: false;
      reason: "web" | "emulador" | "nao_configurado" | "sem_permissao" | "falha";
      message?: string;
    };

interface Saved {
  enabled: boolean;
  token?: string;
}
export const savedPush = () => readJson<Saved>("push", { enabled: true });

const extra = (Constants.expoConfig?.extra ?? {}) as {
  brandId?: string;
  eas?: { projectId?: string };
};
export const pushProjectId = extra.eas?.projectId || undefined;

/** Como o app mostra o alarme com ele aberto: banner, som e na lista. */
export function setupForegroundHandler() {
  if (!pushSupported) return;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

async function ensureChannel() {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync(ALARM_CHANNEL, {
    name: "Alarmes das câmeras",
    importance: Notifications.AndroidImportance.HIGH,
    sound: "default",
    vibrationPattern: [0, 300, 200, 300],
  });
}

/**
 * Registra (ou atualiza) este celular no servidor. `enabled` = preferência do usuário.
 * Só pede permissão ao sistema quando as notificações estão ligadas.
 */
export async function registerPush(api: ApiClient, enabled: boolean): Promise<PushState> {
  if (!pushSupported) return { ok: false, reason: "web" };
  if (!Device.isDevice) return { ok: false, reason: "emulador" };
  if (!pushProjectId) return { ok: false, reason: "nao_configurado" };
  try {
    await ensureChannel();
    if (enabled) {
      let perm = await Notifications.getPermissionsAsync();
      if (!perm.granted && perm.canAskAgain) perm = await Notifications.requestPermissionsAsync();
      if (!perm.granted) {
        writeJson("push", { ...savedPush(), enabled });
        return { ok: false, reason: "sem_permissao" };
      }
    }
    const token = (await Notifications.getExpoPushTokenAsync({ projectId: pushProjectId })).data;
    await api.post("/api/v1/push/devices", {
      token,
      platform: Platform.OS === "ios" ? "ios" : "android",
      brand: extra.brandId ?? "topcam",
      deviceName: (Device.modelName ?? "").slice(0, 100) || undefined,
      appVersion,
      enabled,
    });
    writeJson("push", { enabled, token });
    return { ok: true, enabled };
  } catch (e) {
    return { ok: false, reason: "falha", message: (e as Error).message };
  }
}

/** Ao sair do app: tira este celular da conta (melhor esforço; a sessão também é encerrada). */
export async function unregisterPush(api: ApiClient): Promise<void> {
  const s = savedPush();
  if (!pushSupported || !s.token) return;
  await api.request("DELETE", "/api/v1/push/devices", { token: s.token }).catch(() => undefined);
  writeJson("push", { enabled: s.enabled });
}

export const PUSH_PROBLEM: Record<Exclude<PushState, { ok: true }>["reason"], string> = {
  web: "As notificações funcionam no app do celular.",
  emulador: "As notificações só funcionam num celular de verdade.",
  nao_configurado: "As notificações ainda não foram configuradas nesta versão do app.",
  sem_permissao:
    "O celular não permitiu as notificações. Libere nas configurações do celular (Notificações → " +
    "este app) e volte aqui.",
  falha: "Não foi possível ligar as notificações agora. Tente de novo.",
};

// ---- situação atual (Conta mostra; o registro ao abrir o app atualiza)
let current: PushState | null = null;
const listeners = new Set<() => void>();
export function setPushState(s: PushState) {
  current = s;
  listeners.forEach((l) => l());
}
export function usePushState(): PushState | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => current,
  );
}
