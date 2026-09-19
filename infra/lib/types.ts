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

/**
 * Which virtual machine a chain runs.
 *
 * LayerZero addresses every chain as a `bytes32` and identifies it by `eid`, so the *messaging*
 * layer is already VM-agnostic. What differs per VM is everything around it: how contracts are
 * deployed, how accounts are addressed, and what a "pool" even is. This discriminator is what
 * lets the pipeline route to the right backend instead of assuming EVM everywhere.
 */
export type VmKind = "evm" | "svm";

/** Solana-specific deployment settings. Required when `vm` is "svm". */
export interface SvmConfig {
  /** LayerZero EndpointV2 program id on this cluster. */
  endpointProgramId: string;
  /** OFT program id, once deployed. Recorded in the manifest on first run. */
  oftProgramId?: string;
  /** The CrossStock request program id, once deployed. */
  swapRequestProgramId?: string;
  /** Path to the payer keypair. Solana has no single "private key hex" convention. */
  keypairPath?: string;
  /** Commitment level for reads. */
  commitment?: "processed" | "confirmed" | "finalized";
}

export interface ChainConfig {
  /** Stable identifier used as the manifest key, e.g. "base-sepolia". */
  key: string;
  name: string;
  /** Defaults to "evm" when omitted, so every existing config keeps working untouched. */
  vm?: VmKind;
  /** EVM only. Asserted against the RPC before anything is deployed. */
  chainId?: number;
  /** LayerZero V2 endpoint id. VM-independent — this is how LayerZero routes. */
  eid: number;
  rpcUrl: string;
  /** Present when `vm` is "svm". */
  svm?: SvmConfig;
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
  /** Human-readable units, e.g. "1000000". Minted on the home chain only. Ignored when adapting. */
  initialSupply: string;
  /**
   * Address of an ERC-20 that ALREADY EXISTS on the home chain.
   *
   * When set, the infra does not mint a new token. It deploys an {OmniTokenAdapter} beside the
   * existing one, which locks it and backs representations on every mirror chain. This is how
   * an issuer brings a token they already have: holders keep their balances and the contract
   * address never changes.
   *
   * Only meaningful for the home chain. Mirror chains always receive fresh OmniTokens.
   */
  existingToken?: string;
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
  /** Gas granted to the return packet's lzReceive on each mirror chain. */
  returnGas: number;
  /** Gas granted to SwapRequest.lzCompose on each mirror chain (records + pays out the user). */
  returnComposeGas?: number;
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
  /** Which contract the link belongs to, e.g. "TokenizedStock". Distinguishes the two meshes. */
  label: string;
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
  vm: VmKind;
  /** EVM only. */
  chainId?: number;
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
