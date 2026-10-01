import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import type { KeyStore } from "./api";

/**
 * Cofre do celular (Keychain no iPhone, Keystore no Android) para o refresh token.
 * Na versão web (só usada para testes automáticos) cai no localStorage.
 */
export const keyStore: KeyStore =
  Platform.OS === "web"
    ? {
        get: async (k) => globalThis.localStorage?.getItem(k) ?? null,
        set: async (k, v) => globalThis.localStorage?.setItem(k, v),
        del: async (k) => globalThis.localStorage?.removeItem(k),
      }
    : {
        get: (k) => SecureStore.getItemAsync(k),
        set: (k, v) => SecureStore.setItemAsync(k, v),
        del: (k) => SecureStore.deleteItemAsync(k),
      };
