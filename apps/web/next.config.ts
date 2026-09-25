import type { NextConfig } from "next";
import { resolve } from "node:path";

const config: NextConfig = {
  // The shared package is TypeScript source, compiled by Next rather than prebuilt.
  transpilePackages: ["@boundless-stock/shared", "@boundless-stock/sdk"],
  // The monorepo root, so file tracing includes the deployment records the dashboard reads.
  outputFileTracingRoot: resolve(__dirname, "../.."),
  // The read API reuses the infra's own chain code. Its Solana and LayerZero SDKs are Node
  // libraries with runtime requires; load them from node_modules rather than bundling them.
  serverExternalPackages: [
    "@solana/web3.js",
    "@solana/spl-token",
    "@coral-xyz/anchor",
    "@layerzerolabs/lz-solana-sdk-v2",
    "@layerzerolabs/oft-v2-solana-sdk",
    "@metaplex-foundation/umi",
    "@metaplex-foundation/umi-bundle-defaults",
    "@metaplex-foundation/umi-rpc-web3js",
    "@metaplex-foundation/umi-web3js-adapters",
    "@orca-so/whirlpools-sdk",
    "@orca-so/common-sdk",
  ],
  // The infra is NodeNext-style TypeScript: it imports `./x.js` meaning `./x.ts`. Turbopack has no
  // equivalent of this mapping yet, so the app builds with webpack (see package.json scripts).
  webpack(config) {
    config.resolve.extensionAlias = { ...config.resolve.extensionAlias, ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
};

export default config;
