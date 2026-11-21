import type { ExpoConfig } from "expo/config";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Configuração do app por marca (white label).
 *
 *   BRAND=<marca> (padrão: topcam)  → lê brands/<marca>/brand.json e brands/<marca>/generated/*
 *   API_URL=<endereço>              → troca o servidor (ex.: laboratório); padrão: apiUrl da marca
 *
 * Para um provedor novo: crie brands/<marca>/brand.json (+ logo.png), rode
 * `python3 scripts/brand-assets.py <marca>` e gere o app com BRAND=<marca>.
 *
 * Notificações push (alarmes): cada marca tem o seu projeto na Expo (easProjectId no
 * brand.json) e, no Android, o seu brands/<marca>/google-services.json (Firebase). Sem
 * eles o app funciona normalmente, só não recebe push.
 */

export interface Brand {
  name: string;
  slug: string;
  androidPackage: string;
  iosBundleId: string;
  apiUrl: string;
  primaryColor: string;
  darkColor: string;
  tagline: string;
  supportEmail: string;
  /** Projeto da marca na Expo (push). Vazio = sem push. */
  easProjectId?: string;
}

const brandId = process.env.BRAND || "topcam";
const dir = join(process.cwd(), "brands", brandId);
const brand = JSON.parse(readFileSync(join(dir, "brand.json"), "utf8")) as Brand;
const apiUrl = (process.env.API_URL || brand.apiUrl).replace(/\/+$/, "");
const asset = (f: string) => `./brands/${brandId}/generated/${f}`;
const version = (
  JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version: string }
).version;
const buildNumber = 7;
const googleServices = join(dir, "google-services.json");

const config: ExpoConfig = {
  name: brand.name,
  slug: brand.slug,
  version,
  scheme: brand.slug,
  orientation: "default",
  icon: asset("icon.png"),
  userInterfaceStyle: "light",
  ios: {
    bundleIdentifier: brand.iosBundleId,
    buildNumber: String(buildNumber),
    supportsTablet: true,
    infoPlist: { ITSAppUsesNonExemptEncryption: false },
  },
  android: {
    package: brand.androidPackage,
    versionCode: buildNumber,
    adaptiveIcon: {
      backgroundColor: brand.primaryColor,
      foregroundImage: asset("adaptive-foreground.png"),
      monochromeImage: asset("adaptive-monochrome.png"),
    },
    predictiveBackGestureEnabled: false,
    ...(existsSync(googleServices)
      ? { googleServicesFile: `./brands/${brandId}/google-services.json` }
      : {}),
  },
  web: { favicon: asset("favicon.png"), output: "single" },
  plugins: [
    "expo-router",
    [
      "expo-splash-screen",
      {
        image: asset("splash.png"),
        imageWidth: 180,
        resizeMode: "contain",
        backgroundColor: brand.primaryColor,
      },
    ],
    "expo-secure-store",
    [
      "expo-notifications",
      {
        icon: asset("adaptive-monochrome.png"),
        color: brand.primaryColor,
        defaultChannel: "alarmes",
      },
    ],
    [
      "expo-media-library",
      {
        savePhotosPermission: "Permitir salvar os vídeos baixados das câmeras na galeria.",
        isAccessMediaLocationEnabled: false,
      },
    ],
    ["expo-video", { supportsBackgroundPlayback: false, supportsPictureInPicture: false }],
    [
      "expo-build-properties",
      // Servidor sem HTTPS (só no laboratório): o Android bloqueia HTTP por padrão.
      { android: { usesCleartextTraffic: apiUrl.startsWith("http://") } },
    ],
  ],
  extra: {
    brandId,
    brand: { ...brand, apiUrl },
    ...(brand.easProjectId ? { eas: { projectId: brand.easProjectId } } : {}),
  },
};

export default config;
