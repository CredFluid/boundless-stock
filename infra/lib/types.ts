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
  /**
   * Local decimals of each asset's SPL mint on this chain. Default: the asset's configured
   * decimals, capped at 9.
   *
   * Solana amounts are u64, which holds at most ~18.4 whole units of an 18-decimal token, so a
   * Solana mint generally cannot use the home chain's precision. It does not have to: amounts
   * cross the wire in shared decimals, so each chain picks its own. See `lib/decimals.ts`.
   */
  decimals?: { base?: number; quote?: number };
  /**
   * LOCAL validators only: the native fee, in lamports, the test message library charges per
   * send. Default 50,000. Nonzero on purpose — a real network always charges, and a client or
   * program that forgets to quote and pay should fail here, not on devnet.
   */
  localMessageLibFeeLamports?: number;
  /**
   * What a message delivered TO this chain asks the executor for, in Solana's own terms —
   * compute units, and lamports forwarded to the receiver — rather than EVM gas. Used by every
   * other chain's return legs to this one. Defaults suit the local validator.
   */
  executor?: {
    /** Compute units for `lz_receive`. Default 400,000. */
    lzReceiveComputeUnits?: number;
    /** Lamports forwarded with `lz_receive`: rent for token accounts it opens. Default 2,500,000. */
    lzReceiveValueLamports?: number;
    /** Compute units for `lz_compose`. Default 600,000. */
    lzComposeComputeUnits?: number;
  };
  /**
   * Solana HOME only: the most the relay lets one return leg cost, in lamports, per mirror.
   * The executor's fee payer pays it; the mirror's compose value is what reimburses it.
   * Default 5,000,000.
   */
  maxReturnFeeLamports?: number;
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
  /** Partners allowed to route orders, their fees, and whether orders must come through one. */
  partners?: PartnersConfig;
}

/**
 * Partner access and fees, applied to every mirror chain's request contract.
 *
 * A partner — a wallet, exchange or app — owns its users and their KYC. It authorises each
 * order it approves: an EIP-712 signature on EVM, a co-signature on Solana. Addresses are per
 * VM because a partner's keys differ between them.
 */
export interface PartnersConfig {
  /** Close the plain buy/sell entrypoints, so every order needs a partner. Default false. */
  required?: boolean;
  /** Platform fee on every fee-bearing order, in basis points (at most 100), and its recipient. */
  platformFee?: { bps: number; recipient: { evm?: string; svm?: string } };
  partners?: PartnerConfig[];
}

export interface PartnerConfig {
  /** Non-zero, unique within the deployment; it names the partner on chain. */
  id: number;
  name: string;
  /** The most the partner may charge on one order, in basis points (at most 300). */
  maxFeeBps: number;
  /** Default true. False stops new orders at once; fees already escrowed are unaffected. */
  active?: boolean;
  /** EVM: the key that signs order authorisations, and where fees accrue. */
  evm?: { signer: string; feeRecipient: string };
  /** Solana: the key that co-signs orders, and the wallet whose token accounts receive fees. */
  svm?: { signer: string; feeRecipient: string };
  /**
   * Where order events for this partner's orders are delivered (`npm run webhooks`). The signing
   * secret is read from the environment variable named here, never stored in the config.
   */
  webhook?: { url: string; secretEnv: string };
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
