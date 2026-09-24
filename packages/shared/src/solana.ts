/**
 * The Solana deployment records the infra writes beside each manifest:
 * `deployments/<name>.<chainKey>.solana.json`. Declared here as plain data — the infra's own
 * interfaces live next to runtime code (web3.js, LayerZero SDKs) that an app should not import.
 */
export interface SolanaAssetRecord {
  symbol: string;
  decimals: number;
  mint: string;
  oftStore: string;
  escrow: string;
  mode?: "launch" | "adapt";
  peers: { remoteEid: number; address: string; verified?: boolean }[];
}

export interface SolanaChainRecord {
  name: string;
  vm: "svm";
  /** Present, as "home", on a Solana home chain's record; absent on a mirror's. */
  role?: "home";
  createdAt: string;
  chain: { key: string; name: string; eid: number; rpcUrl: string };
  payer: string;
  programs: Record<string, string>;
  assets: { base: SolanaAssetRecord; quote: SolanaAssetRecord };
  /** Mirror only. */
  homeChain?: { key: string; eid: number; relay: string };
  swapRequest?: { store: string };
  /** Home only. */
  pool?: { whirlpool: string; mintA: string; mintB: string; tickSpacing?: number };
  relay?: { store: string; alt: string; peers: { eid: number; request: string }[]; routes: number };
}
