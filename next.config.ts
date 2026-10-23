import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 舊站（WordPress）網址一律以斜線結尾，保留相同網址結構
  trailingSlash: true,
  poweredByHeader: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
