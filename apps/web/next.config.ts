import type { NextConfig } from "next";

// Web は UI 専用。/api/* は API サーバへ転送し、同一オリジンの Cookie で認証する（docs/architecture.md）。
const apiOrigin = process.env.API_INTERNAL_URL ?? "http://localhost:4000";

const config: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiOrigin}/api/:path*` }];
  },
};

export default config;
