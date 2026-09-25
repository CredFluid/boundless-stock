import { parseAbi, formatUnits, type Address, type Hex } from "viem";
import type { Manifest, DeploymentConfig } from "../lib/types.js";
import { Chain, buildChains } from "../lib/chains.js";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig, allChains, vmOf } from "../lib/config.js";
import { loadManifestAt, loadManifest } from "../lib/manifest.js";
import { forgeArtifact } from "../lib/artifacts.js";
import { Options } from "../lib/options.js";
import { PARTNER_ABI } from "../lib/partners.js";
import { toBytes32 } from "../lib/address.js";
import { Relayer } from "../relayer.js";
import { SolanaChain } from "../solana/chain.js";
import { SolanaRelayEndpoint } from "../solana/relay.js";
import { SolanaSwapClient, ataOf } from "../solana/client.js";
import { ComputeBudgetProgram, PublicKey, Transaction } from "@solana/web3.js";
import { createNoopSigner, publicKey } from "@metaplex-foundation/umi";
import { toWeb3JsInstruction } from "@metaplex-foundation/umi-web3js-adapters";
import { oft } from "@layerzerolabs/oft-v2-solana-sdk";
import { lzLocal } from "../solana/lz-local.js";
import { solanaHome } from "../lib/market.js";
import { programOf } from "../solana/token.js";

/** Anvil account #1 — the end user, deliberately not the deployer. */
const ANVIL_KEY_1: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
import { log } from "../lib/logger.js";

/**
 * Shared context and helpers for the validation scenarios.
 *
 * The scenarios are written once and run unchanged against either environment. The only
 * difference is who moves packets: locally the bundled relayer does it, on a live chain
 * LayerZero's DVN and Executor do, and `settle()` hides that behind one call. If a scenario
 * needed to know which environment it was in, it would not really be validating the
 * deployment — it would be validating the harness.
 */

export const OFT_ABI = parseAbi([
  "struct SendParam { uint32 dstEid; bytes32 to; uint256 amountLD; uint256 minAmountLD; bytes extraOptions; bytes composeMsg; bytes oftCmd; }",
  "struct MessagingFee { uint256 nativeFee; uint256 lzTokenFee; }",
  "function quoteSend(SendParam _sendParam, bool _payInLzToken) view returns (MessagingFee)",
  "struct MessagingReceipt { bytes32 guid; uint64 nonce; MessagingFee fee; }",
  "struct OFTReceipt { uint256 amountSentLD; uint256 amountReceivedLD; }",
  "function send(SendParam _sendParam, MessagingFee _fee, address _refundAddress) payable returns (MessagingReceipt, OFTReceipt)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function sharedDecimals() view returns (uint8)",
  "function peers(uint32) view returns (bytes32)",
  "function approvalRequired() view returns (bool)",
]);

export enum Direction {
  BUY = 0,
  SELL = 1,
}

export enum Status {
  NONE = 0,
  PENDING = 1,
  FILLED = 2,
  REFUNDED = 3,
  STRANDED = 4,
  CANCELLED = 5,
}

export interface RequestRecord {
  user: Address;
  direction: number;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  minAmountOut: bigint;
  amountOut: bigint;
  createdAt: bigint;
  settledAt: bigint;
  status: Status;
  failureReason: number;
  /** The LayerZero nonce of the request's outbound message, on its OFT's path home. */
  lzNonce: bigint;
}

export interface ScenarioResult {
  name: string;
  passed: boolean;
  detail: string;
  metrics: Record<string, string | number>;
  findings: string[];
}

export class Harness {
  readonly manifest: Manifest;
  readonly config: DeploymentConfig;
  readonly chains: Map<string, Chain>;
  readonly relayer: Relayer | null;
  /** One client per Solana mirror chain in the deployment. Empty for an EVM-only deployment. */
  readonly solana: SolanaSwapClient[];

  constructor(config: DeploymentConfig, manifest: Manifest) {
    this.config = config;
    this.manifest = manifest;
    this.chains = buildChains(allChains(config).filter((c) => vmOf(c) === "evm"));
    const svm = allChains(config)
      .filter((c) => vmOf(c) === "svm")
      .map((c) => new SolanaChain(c));
    // A client per Solana MIRROR; a Solana home chain has no SwapRequest to drive.
    this.solana = svm.filter((c) => c.config.key !== config.homeChain.key).map((c) => new SolanaSwapClient(config, c));
    this.relayer =
      manifest.environment === "local"
        ? new Relayer(manifest, this.chains, svm.map((c) => new SolanaRelayEndpoint(c)))
        : null;
    if (this.relayer) this.relayer.verbose = process.env.RELAY_VERBOSE === "1";
  }

  static async create(opts: { config?: string; manifest?: string }): Promise<Harness> {
    const config = loadConfig(opts.config ?? "config/localnet.json");
    const manifest = opts.manifest ? loadManifestAt(opts.manifest) : loadManifest(config.name);
    if (!manifest) throw new Error(`No manifest for "${config.name}" — run the deployment first.`);
    return new Harness(config, manifest);
  }

  get home(): Chain {
    return this.chains.get(this.manifest.homeChainKey)!;
  }
  get mirrorKeys(): string[] {
    return Object.values(this.manifest.chains)
      .filter((c) => c.role === "mirror")
      .map((c) => c.key);
  }
  chain(key: string): Chain {
    const c = this.chains.get(key);
    if (!c) throw new Error(`No chain "${key}" in this deployment.`);
    return c;
  }
  addr(chainKey: string, contract: string): Address {
    const a = this.manifest.chains[chainKey]?.contracts[contract];
    if (!a) throw new Error(`No "${contract}" on chain "${chainKey}".`);
    return a as Address;
  }

  /**
   * The contract that moves an asset across chains: the token itself for a launched asset,
   * or its adapter for one that already existed.
   *
   * Anything that bridges must go through this rather than the token address — an adapted
   * asset is a plain ERC-20 with no `quoteSend` on it at all.
   */
  oftAddr(chainKey: string, contract: "TokenizedStock" | "QuoteAsset"): Address {
    return (this.manifest.chains[chainKey]?.contracts[`${contract}Oft`] ?? this.addr(chainKey, contract)) as Address;
  }

  /** True when the asset is adapted rather than launched on this chain. */
  isAdapted(chainKey: string, contract: "TokenizedStock" | "QuoteAsset"): boolean {
    return this.oftAddr(chainKey, contract).toLowerCase() !== this.addr(chainKey, contract).toLowerCase();
  }

  /**
   * Bridge an asset from the home chain to a mirror chain, handling both deployment modes.
   * @dev An adapter pulls with `transferFrom`, so it needs an allowance first; a launched
   *      OmniToken burns from the caller and needs none.
   */
  async bridgeFromHome(
    mirrorKey: string,
    contract: "TokenizedStock" | "QuoteAsset",
    to: Address,
    amount: bigint
  ): Promise<void> {
    await this.bridgeFromHomeTo(this.eid(mirrorKey), toBytes32(to), contract, amount);
  }

  /**
   * Bridge from the home chain to any eid and 32-byte recipient — including a Solana wallet,
   * which has no EVM address and no entry in the EVM manifest.
   */
  async bridgeFromHomeTo(
    dstEid: number,
    to: Hex,
    contract: "TokenizedStock" | "QuoteAsset",
    amount: bigint
  ): Promise<void> {
    if (vmOf(this.config.homeChain) === "svm") return this.bridgeFromSolanaHome(dstEid, to, contract, amount);
    const homeKey = this.manifest.homeChainKey;
    const oft = this.oftAddr(homeKey, contract);

    if (this.isAdapted(homeKey, contract)) {
      await this.home.write(this.addr(homeKey, contract), OFT_ABI, "approve", [oft, amount]);
    }

    const sendParam = {
      dstEid,
      to,
      amountLD: amount,
      minAmountLD: 0n,
      extraOptions: Options.new().addExecutorLzReceive(200_000n).build(),
      composeMsg: "0x" as const,
      oftCmd: "0x" as const,
    };
    const fee = await this.home.read<{ nativeFee: bigint; lzTokenFee: bigint }>(oft, OFT_ABI, "quoteSend", [
      sendParam,
      false,
    ]);
    await this.home.write(oft, OFT_ABI, "send", [sendParam, fee, this.home.deployer], fee.nativeFee);
  }
  /**
   * {@link bridgeFromHomeTo} when home is Solana: an OFT send from the Solana deployer's genesis
   * balance, with the messaging fee quoted and paid. `amount` is in the home mint's decimals.
   */
  private async bridgeFromSolanaHome(
    dstEid: number,
    to: Hex,
    contract: "TokenizedStock" | "QuoteAsset",
    amount: bigint
  ): Promise<void> {
    const home = solanaHome(this.config)!;
    const sol = new SolanaChain(this.config.homeChain);
    const a = home.assets[contract === "TokenizedStock" ? "base" : "quote"];
    const params = {
      dstEid,
      to: Buffer.from(to.slice(2).padStart(64, "0"), "hex"),
      amountLd: amount,
      minAmountLd: amount,
      options: Buffer.from(Options.new().addExecutorLzReceive(200_000n).build().slice(2), "hex"),
    };
    const rpc = lzLocal(sol).rpc;
    const payer = sol.payer.publicKey.toBase58();
    const { nativeFee } = await oft.quote(
      rpc,
      { payer: publicKey(payer), tokenMint: publicKey(a.mint), tokenEscrow: publicKey(a.escrow) },
      params,
      { oft: publicKey(home.programs.oft) }
    );
    const ix = await oft.send(
      rpc,
      {
        payer: createNoopSigner(publicKey(payer)),
        tokenMint: publicKey(a.mint),
        tokenEscrow: publicKey(a.escrow),
        tokenSource: publicKey(ataOf(sol.payer.publicKey, new PublicKey(a.mint), programOf(a)).toBase58()),
      },
      { ...params, nativeFee },
      { oft: publicKey(home.programs.oft), token: publicKey(programOf(a).toBase58()) }
    );
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
      toWeb3JsInstruction(ix.instruction)
    );
    await sol.connection.confirmTransaction(await sol.connection.sendTransaction(tx, [sol.payer]), "confirmed");
  }

  eid(chainKey: string): number {
    return this.manifest.chains[chainKey].eid;
  }
  name(chainKey: string): string {
    return this.manifest.chains[chainKey].name;
  }

  get tokenDecimals(): number {
    return this.manifest.token.decimals;
  }
  get quoteDecimals(): number {
    return this.manifest.quoteAsset.decimals;
  }
  get tokenSymbol(): string {
    return this.manifest.token.symbol;
  }
  get quoteSymbol(): string {
    return this.manifest.quoteAsset.symbol;
  }

  fmtToken(v: bigint): string {
    return `${formatUnits(v, this.tokenDecimals)} ${this.tokenSymbol}`;
  }
  fmtQuote(v: bigint): string {
    return `${formatUnits(v, this.quoteDecimals)} ${this.quoteSymbol}`;
  }

  /**
   * Moves any in-flight LayerZero packets, then returns.
   *
   * Local: drives the bundled relayer, which performs the same verify -> lzReceive ->
   * lzCompose sequence a DVN and Executor perform.
   * Live: a no-op — LayerZero's own infrastructure is already doing it, and the caller's
   * polling loop is what waits.
   */
  async settle(): Promise<void> {
    if (this.relayer) await this.relayer.drain();
  }

  /** Polls a predicate until it holds or the deadline passes. Returns elapsed ms. */
  async waitFor(
    label: string,
    predicate: () => Promise<boolean>,
    timeoutMs = 120_000,
    intervalMs = 500
  ): Promise<{ ok: boolean; elapsedMs: number }> {
    const start = Date.now();
    for (;;) {
      await this.settle();
      if (await predicate()) return { ok: true, elapsedMs: Date.now() - start };
      if (Date.now() - start > timeoutMs) {
        log.warn(`timed out waiting for ${label} after ${timeoutMs}ms`);
        return { ok: false, elapsedMs: Date.now() - start };
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }


  /**
   * A chain client for the *end user*, distinct from the deployer.
   *
   * The core claim is about a user standing on a mirror chain, so proving it with the deployer's
   * own account would leave an obvious hole: the deployer owns the token, the pool and both
   * relay contracts. Anvil's account #1 is used by default; set USER_PRIVATE_KEY to override.
   *
   * On a live chain with only one funded key this falls back to the deployer and says so, since
   * quietly proving a weaker claim is worse than proving it loudly.
   */
  user(chainKey: string): Chain {
    const key = (process.env.USER_PRIVATE_KEY as Hex | undefined) ?? ANVIL_KEY_1;
    return new Chain(this.chain(chainKey).config, key);
  }

  get userAddress(): Address {
    const key = (process.env.USER_PRIVATE_KEY as Hex | undefined) ?? ANVIL_KEY_1;
    return privateKeyToAccount(key).address;
  }

  /**
   * Spot price of the home pool, as quote units per 1 base unit.
   *
   * Uniswap's sqrtPriceX96 is always token1-per-token0 in raw units, and which asset is token0
   * depends on address ordering, so the conversion is done here once rather than inline.
   */
  async spotPrice(): Promise<number> {
    const poolAbi = parseAbi([
      "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 a, uint16 b, uint16 c, uint8 d, bool e)",
    ]);
    const pool = this.manifest.pool!;
    const slot0 = await this.home.read<readonly [bigint, ...unknown[]]>(pool.address as Address, poolAbi, "slot0");
    const sqrtP = Number(slot0[0]) / 2 ** 96;
    const rawToken1PerToken0 = sqrtP * sqrtP;

    const base = this.addr(this.manifest.homeChainKey, "TokenizedStock").toLowerCase();
    const baseIsToken0 = pool.token0.toLowerCase() === base;
    const rawQuotePerBase = baseIsToken0 ? rawToken1PerToken0 : 1 / rawToken1PerToken0;

    return rawQuotePerBase * 10 ** (this.tokenDecimals - this.quoteDecimals);
  }


  /**
   * Makes sure the end user holds at least `amount` of the omnichain asset on a mirror chain,
   * bridging from the home chain if not.
   *
   * Setup, not part of any proof: the user has to get the asset onto the mirror somehow, and
   * the direct bridge (already validated by scenario 1) is how. Note what this does *not* do —
   * it never puts the quote asset or any liquidity on the mirror chain, because that is
   * precisely the thing being claimed absent.
   */
  async ensureUserFunded(
    mirrorKey: string,
    amount: bigint,
    contract: "TokenizedStock" | "QuoteAsset" = "TokenizedStock"
  ): Promise<void> {
    const balanceOf = async () =>
      contract === "TokenizedStock"
        ? this.tokenBalance(mirrorKey, this.userAddress)
        : this.quoteBalance(mirrorKey, this.userAddress);

    const held = await balanceOf();
    if (held >= amount) return;

    await this.bridgeFromHome(mirrorKey, contract, this.userAddress, amount - held);
    await this.waitFor("user funding to arrive", async () => (await balanceOf()) >= amount);
  }

  async getRequest(mirrorKey: string, requestId: bigint): Promise<RequestRecord> {
    const abi = forgeArtifact("SwapRequest").abi;
    const r = await this.chain(mirrorKey).read<RequestRecord>(
      this.addr(mirrorKey, "SwapRequest"),
      abi,
      "getRequest",
      [requestId]
    );
    return r;
  }

  async tokenBalance(chainKey: string, holder: Address): Promise<bigint> {
    return this.chain(chainKey).read<bigint>(this.addr(chainKey, "TokenizedStock"), OFT_ABI, "balanceOf", [holder]);
  }

  /** Quote-asset balance on any chain in the set (it is omnichain). */
  async quoteBalance(chainKey: string, holder: Address): Promise<bigint> {
    return this.chain(chainKey).read<bigint>(this.addr(chainKey, "QuoteAsset"), OFT_ABI, "balanceOf", [holder]);
  }

  /**
   * The conserved quantity for an omnichain asset, in either deployment mode.
   *
   * LAUNCHED asset (a native OmniToken): every chain's `totalSupply()` is a genuine slice of
   * one omnichain supply, so the figure is simply their sum.
   *
   * ADAPTED asset (a pre-existing ERC-20 behind an OmniTokenAdapter): the home token's
   * `totalSupply()` includes every coin that has never touched this system, and the mirror
   * chains mint representations *backed by* the adapter's locked balance. Summing raw supplies
   * therefore double-counts everything in flight through the lockbox. Subtracting the locked
   * amount from the home contribution restores conservation: a token moving to a mirror is
   * locked here (home contribution falls) and minted there (mirror contribution rises) by the
   * same amount.
   *
   * Reduces to the same arithmetic in both modes, since a launched asset has no adapter and
   * therefore nothing locked.
   */
  async totalSupplyAcrossChains(
    contract: "TokenizedStock" | "QuoteAsset" = "TokenizedStock"
  ): Promise<{ perChain: Record<string, bigint>; total: bigint }> {
    const perChain: Record<string, bigint> = {};
    let total = 0n;

    for (const key of Object.keys(this.manifest.chains)) {
      const token = this.addr(key, contract);
      const oft = this.manifest.chains[key].contracts[`${contract}Oft`] as Address | undefined;

      let counted = await this.chain(key).read<bigint>(token, OFT_ABI, "totalSupply");

      if (oft && oft.toLowerCase() !== token.toLowerCase()) {
        const locked = await this.chain(key).read<bigint>(token, OFT_ABI, "balanceOf", [oft]);
        counted -= locked; // backing for representations that live on other chains
      }

      perChain[key] = counted;
      total += counted;
    }
    return { perChain, total };
  }

  /**
   * Confirms the premise the whole POC rests on: the mirror chain has **no market**.
   *
   * Precisely what is checked, because the distinction carries the whole claim. The mirror
   * chain holds token *contracts*, and users hold *wallet balances* — neither is liquidity.
   * What must not exist there is anything that could discover a price or take the other side
   * of a trade: a pool, a router, a factory. Re-checked inside the scenarios rather than
   * assumed, because "no market on the mirror chain" is the claim, not the setup.
   */
  async assertNoLocalMarket(mirrorKey: string): Promise<string[]> {
    const findings: string[] = [];
    const contracts = this.manifest.chains[mirrorKey].contracts;

    for (const forbidden of ["Pool", "SwapRouter", "UniswapV3Factory", "NonfungiblePositionManager"]) {
      if (contracts[forbidden]) {
        findings.push(`${mirrorKey} has a ${forbidden} deployed — a mirror chain must have no market`);
      }
    }

    // The infra must never seed anything here. The only way an asset reaches a mirror chain is
    // a user bridging it into their own wallet. The one thing SwapRequest may hold is fees from
    // partner orders — escrowed, or earned and not yet withdrawn — which are owed to someone
    // and are not liquidity; the contract tracks them exactly in `feesReserved`.
    const requestAddr = this.addr(mirrorKey, "SwapRequest");
    const reserved = (token: Address) =>
      this.chain(mirrorKey).read<bigint>(requestAddr, PARTNER_ABI, "feesReserved", [token]);
    const stockHeld =
      (await this.tokenBalance(mirrorKey, requestAddr)) - (await reserved(this.addr(mirrorKey, "TokenizedStock")));
    const quoteHeld =
      (await this.quoteBalance(mirrorKey, requestAddr)) - (await reserved(this.addr(mirrorKey, "QuoteAsset")));
    if (stockHeld !== 0n) findings.push(`${mirrorKey} SwapRequest holds ${stockHeld} stock before the test`);
    if (quoteHeld !== 0n) findings.push(`${mirrorKey} SwapRequest holds ${quoteHeld} quote before the test`);

    return findings;
  }
}

export { forgeArtifact };
export type { Hex };
