import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 舊站（WordPress）網址一律以斜線結尾，保留相同網址結構
  trailingSlash: true,
  // 斜線補全改由 src/proxy.ts 處理，讓 MCP 端點 /api/mcp（無結尾斜線）可直接回應 POST，不經 308 轉址
  skipTrailingSlashRedirect: true,
  poweredByHeader: false,
  experimental: {
    serverActions: { bodySizeLimit: "4mb" }, // 後台媒體上傳（Vercel 請求上限 4.5MB）
  },
  serverExternalPackages: ["sharp"],
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
