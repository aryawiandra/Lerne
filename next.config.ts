import type { NextConfig } from "next";

// Every Lerne page is per-user and must render at request time, so the
// scaffold's cacheComponents / partialPrefetching opt-ins are left off.
const nextConfig: NextConfig = {
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
