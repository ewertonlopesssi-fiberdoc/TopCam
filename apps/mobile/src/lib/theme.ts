import { brand } from "./brand";
import type { Tone } from "./cameras";

export const colors = {
  primary: brand.primaryColor,
  dark: brand.darkColor,
  bg: "#f4f6fa",
  card: "#ffffff",
  line: "#e2e8f0",
  ink: "#0f172a",
  muted: "#64748b",
  danger: "#dc2626",
};

export const tones: Record<Tone, { fg: string; bg: string }> = {
  green: { fg: "#047857", bg: "#d1fae5" },
  red: { fg: "#b91c1c", bg: "#fee2e2" },
  amber: { fg: "#b45309", bg: "#fef3c7" },
  slate: { fg: "#475569", bg: "#e2e8f0" },
};
