/**
 * Shared types for the CrossStock deployment infrastructure.
 *
 * Everything chain-specific lives in config. No chain id, eid, endpoint address, token name
 * or liquidity figure appears anywhere in the module code — that is the property that makes
 * this infra reusable for a different token or a different chain set.
 */

/** Uniswap V3 addresses on a chain. Omitted entries are deployed by the infra if needed. */
export interface UniswapConfig {
  factory?: string;
  swapRouter?: string;
  positionManager?: string;
  weth9?: string;
  /** Deploy any missing pieces from the official artifacts rather than failing. */
  deployIfMissing?: boolean;
}

export interface ChainConfig {
  /** Stable identifier used as the manifest key, e.g. "base-sepolia". */
  key: string;
  name: string;
  chainId: number;
  /** LayerZero V2 endpoint id. */
  eid: number;
  rpcUrl: string;
  /**
   * LayerZero EndpointV2 address. Omit to have the infra deploy a local endpoint stack
   * (EndpointV2Mock + LocalMessageLib) — used only by the local development environment.
   */
  lzEndpoint?: string;
  nativeSymbol?: string;
  /** Optional explorer base URL, recorded in the manifest for convenience. */
  explorer?: string;
  uniswap?: UniswapConfig;
}

export interface TokenConfig {
  name: string;
  symbol: string;
  decimals: number;
  /** Human-readable units, e.g. "1000000". Minted on the home chain only. */
  initialSupply: string;
}

export interface PoolConfig {
  /** Uniswap V3 fee tier in hundredths of a bip: 500 | 3000 | 10000. */
  feeTier: number;
  /** Initial price expressed as quote-asset units per 1 base token, e.g. "150". */
  initialPrice: string;
  /** Seed liquidity, human units. */
  baseLiquidity: string;
  quoteLiquidity: string;
  /**
   * Half-width of the seeded position in ticks. Wide is fine for a POC: it keeps the pool
   * from running out of range during validation.
   */
  tickHalfWidth?: number;
}

export interface RelayConfig {
  /** Gas granted to the OFT's lzReceive on the home chain. */
  homeLzReceiveGas: number;
  /** Gas granted to SwapRelay.lzCompose on the home chain — this is the swap itself. */
  homeComposeGas: number;
  /** Native value (home chain) forwarded to SwapRelay to fund the return leg, in ether units. */
  homeComposeValue: string;
  /** Gas granted to the return message on each mirror chain. */
  returnGas: number;
  /** Native pre-funding for SwapRelay, in ether units. A buffer, not the primary funding path. */
  relayNativeBuffer: string;
}

export interface DeploymentConfig {
  /** Names the manifest file. */
  name: string;
  token: TokenConfig;
  quoteAsset: TokenConfig;
  homeChain: ChainConfig;
  mirrorChains: ChainConfig[];
  pool: PoolConfig;
  relay: RelayConfig;
  /** Base native fee charged by the local message library, in ether units. Local mode only. */
  localMessageLibFee?: string;
}

// --------------------------------------------------------------------------- manifest

export interface PeerRecord {
  /** Which contract role this wiring belongs to: "oft" or "relay". */
  kind: "oft" | "relay";
  fromChain: string;
  toChain: string;
  toEid: number;
  /** What we wrote. */
  expected: string;
  /** What reading it back returned. Equality is what "verified" means. */
  actual: string;
  verified: boolean;
  txHash?: string;
}

export interface ChainDeployment {
  key: string;
  name: string;
  chainId: number;
  eid: number;
  role: "home" | "mirror";
  lzEndpoint: string;
  /** Present only for locally deployed endpoint stacks. */
  localMessageLib?: string;
  contracts: Record<string, string>;
  /** Deployment cost on this chain for the run that produced this manifest. */
  deploymentGas?: { gasUsed: string; txCount: number };
}

export interface PoolDeployment {
  address: string;
  token0: string;
  token1: string;
  feeTier: number;
  initialPrice: string;
  sqrtPriceX96: string;
  liquidity: string;
  reserves: { base: string; quote: string };
  positionTokenId?: string;
}

export interface Manifest {
  name: string;
  version: string;
  createdAt: string;
  updatedAt: string;
  /** "local" when any chain used a locally deployed endpoint stack. */
  environment: "local" | "live";
  deployer: string;
  token: TokenConfig;
  quoteAsset: TokenConfig;
  homeChainKey: string;
  chains: Record<string, ChainDeployment>;
  peers: PeerRecord[];
  pool?: PoolDeployment;
  /** Human-readable trail of which modules ran and when. */
  steps: { module: string; status: "ok" | "failed"; at: string; detail?: string }[];
}
