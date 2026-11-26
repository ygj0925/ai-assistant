import type { NextConfig } from "next";

const config: NextConfig = {
  devIndicators: false,
  poweredByHeader: false,
  headers() {
    return [{
      source: "/share",
      headers: [
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
      ],
    }, {
      source: "/organization-sso/:path*",
      headers: [
        { key: "Cache-Control", value: "no-store" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
        { key: "X-Frame-Options", value: "DENY" },
      ],
    }];
  },
  webpack(config) {
    // The shared Node ESM SDK uses .js specifiers in its TypeScript sources.
    config.resolve.extensionAlias = { ...config.resolve.extensionAlias, ".js": [".js", ".ts"] };
    return config;
  },
};

export default config;
