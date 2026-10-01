import type { ExpoConfig } from "expo/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Configuração do app por marca (white label).
 *
 *   BRAND=<marca> (padrão: topcam)  → lê brands/<marca>/brand.json e brands/<marca>/generated/*
 *   API_URL=<endereço>              → troca o servidor (ex.: laboratório); padrão: apiUrl da marca
 *
 * Para um provedor novo: crie brands/<marca>/brand.json (+ logo.png), rode
 * `python3 scripts/brand-assets.py <marca>` e gere o app com BRAND=<marca>.
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
}

const brandId = process.env.BRAND || "topcam";
const dir = join(process.cwd(), "brands", brandId);
const brand = JSON.parse(readFileSync(join(dir, "brand.json"), "utf8")) as Brand;
const apiUrl = (process.env.API_URL || brand.apiUrl).replace(/\/+$/, "");
const asset = (f: string) => `./brands/${brandId}/generated/${f}`;
const version = (
  JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version: string }
).version;
const buildNumber = 1;

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
    ["expo-video", { supportsBackgroundPlayback: false, supportsPictureInPicture: false }],
    [
      "expo-build-properties",
      // Servidor sem HTTPS (só no laboratório): o Android bloqueia HTTP por padrão.
      { android: { usesCleartextTraffic: apiUrl.startsWith("http://") } },
    ],
  ],
  extra: { brandId, brand: { ...brand, apiUrl } },
};

export default config;
