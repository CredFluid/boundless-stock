import type { NextConfig } from "next";
import { resolve } from "node:path";

const config: NextConfig = {
  // The shared package is TypeScript source, compiled by Next rather than prebuilt.
  transpilePackages: ["@crossstock/shared"],
  // The monorepo root, so file tracing includes the deployment records the dashboard reads.
  outputFileTracingRoot: resolve(__dirname, "../.."),
};

export default config;
