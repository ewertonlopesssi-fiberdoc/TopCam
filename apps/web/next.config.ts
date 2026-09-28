import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  // Servidor Node autocontido (imagem Docker enxuta).
  output: "standalone",
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  reactStrictMode: true,
  poweredByHeader: false,
  // Em desenvolvimento (next dev), encaminha a API para o gateway local.
  async rewrites() {
    return process.env.NODE_ENV === "development"
      ? [
          {
            source: "/api/:path*",
            destination: `${process.env.API_ORIGIN ?? "http://localhost"}/api/:path*`,
          },
        ]
      : [];
  },
};

export default config;
