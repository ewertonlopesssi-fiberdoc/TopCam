import Constants from "expo-constants";

/** Marca do app (white label): vem de brands/<marca>/brand.json via app.config.ts. */
export interface Brand {
  name: string;
  slug: string;
  apiUrl: string;
  primaryColor: string;
  darkColor: string;
  tagline: string;
  supportEmail: string;
}

const extra = (Constants.expoConfig?.extra ?? {}) as { brand?: Brand };

export const brand: Brand = extra.brand ?? {
  name: "TopCam",
  slug: "topcam",
  apiUrl: "https://topcam.suportinet.com.br",
  primaryColor: "#1d63e6",
  darkColor: "#0f1d3a",
  tagline: "Monitoramento de Câmeras",
  supportEmail: "",
};

export const appVersion = Constants.expoConfig?.version ?? "?";
