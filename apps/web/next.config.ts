import type { NextConfig } from "next";

const config: NextConfig = {
  cacheComponents: true,
  // source-only workspace package: Next compiles its .ts alongside the app
  transpilePackages: ["@repo/stripe-connect-protocol"],
};

export default config;
