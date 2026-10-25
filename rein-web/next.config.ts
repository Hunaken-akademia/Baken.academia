import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The history profile is fetched by prebuild into data/ and read at runtime through
  // process.cwd(), which file tracing cannot discover on its own. Declare it so the
  // bundle keeps serving REIN history adjustments and /api/internal/history-profile.
  outputFileTracingIncludes: { "/**": ["./data/history-profile.json.gz", "./data/cushion-comparisons.json.gz.b64", "./data/*-jockey-reference.json.gz.b64", "./data/dictionary/*.json.gz.b64"] },
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Content-Security-Policy", value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    ] }];
  },
};
export default nextConfig;
