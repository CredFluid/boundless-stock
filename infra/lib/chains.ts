import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type TransactionReceipt,
  encodeDeployData,
  encodeFunctionData,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ChainConfig } from "./types.js";
import type { Artifact } from "./artifacts.js";

/** Anvil's first default account. Used only when no DEPLOYER_PRIVATE_KEY is configured. */
/**
 * Safety margin applied on top of every gas estimate. 1.4x is chosen to clear the cold-SSTORE
 * boundary comfortably while still failing fast on a genuinely runaway call.
 */
export const GAS_MARGIN = 1.4;

export const ANVIL_KEY_0: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export function deployerKey(): Hex {
  const k = process.env.DEPLOYER_PRIVATE_KEY;
  if (k && k !== "0x" && k.length === 66) return k as Hex;
  return ANVIL_KEY_0;
}

/**
 * A single chain's clients plus the small set of operations the modules need.
 *
 * Every module talks to chains only through this class, so nothing downstream ever needs to
 * know whether it is pointed at anvil or at Base Sepolia.
 */
export class Chain {
  readonly config: ChainConfig;
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly account: ReturnType<typeof privateKeyToAccount>;

  constructor(config: ChainConfig, privateKey: Hex = deployerKey()) {
    this.config = config;
    this.account = privateKeyToAccount(privateKey);

    const chain = defineChain({
      id: config.chainId,
      name: config.name,
      nativeCurrency: { name: config.nativeSymbol ?? "Ether", symbol: config.nativeSymbol ?? "ETH", decimals: 18 },
      rpcUrls: { default: { http: [config.rpcUrl] } },
    });

    const transport = http(config.rpcUrl, { timeout: 120_000, retryCount: 3 });

    // cacheTime: 0 is load-bearing, not a tuning knob.
    //
    // viem caches getBlockNumber() for `cacheTime`, which defaults to the polling interval
    // (4s). A deployment tool and a packet relayer both make decisions from the chain head
    // within that window: the relayer compares head against its scan cursor, and a stale head
    // makes it conclude there is nothing new and skip blocks that DO contain packets. That
    // failure is invisible and timing-dependent — it disappears the moment anything waits a
    // few seconds. Nothing here should ever act on a cached view of chain state.
    this.publicClient = createPublicClient({ chain, transport, cacheTime: 0 }) as PublicClient;
    this.walletClient = createWalletClient({ chain, transport, account: this.account });
  }

  get key(): string {
    return this.config.key;
  }
  get eid(): number {
    return this.config.eid;
  }
  get name(): string {
    return this.config.name;
  }
  get deployer(): Address {
    return this.account.address;
  }

  async deploy(artifact: Artifact, args: readonly unknown[] = [], value?: bigint): Promise<Address> {
    const hash = await this.walletClient.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      args: args as never,
      account: this.account,
      chain: this.walletClient.chain,
      gas: await this.gasWithMargin(() =>
        this.publicClient.estimateGas({
          account: this.account,
          data: encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args: args as never }),
          ...(value !== undefined ? { value } : {}),
        })
      ),
      ...(value !== undefined ? { value } : {}),
    } as never);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`Deployment reverted on ${this.name} (tx ${hash}).`);
    if (!receipt.contractAddress) throw new Error(`No contract address in receipt on ${this.name} (tx ${hash}).`);
    return receipt.contractAddress;
  }

  async write(
    address: Address,
    abi: Abi,
    functionName: string,
    args: readonly unknown[] = [],
    value?: bigint
  ): Promise<TransactionReceipt> {
    const { request } = await this.publicClient.simulateContract({
      address,
      abi,
      functionName,
      args: args as never,
      account: this.account,
      ...(value !== undefined ? { value } : {}),
    });

    const gas = await this.gasWithMargin(() =>
      this.publicClient.estimateContractGas({
        address,
        abi,
        functionName,
        args: args as never,
        account: this.account,
        ...(value !== undefined ? { value } : {}),
      })
    );

    const hash = await this.walletClient.writeContract({ ...(request as object), gas } as never);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`${functionName}() reverted on ${this.name} (tx ${hash}).`);
    }
    return receipt;
  }


  /**
   * Sends a transaction with an explicit gas limit and no pre-flight simulation, returning the
   * receipt whether it succeeded or reverted.
   *
   * Needed by the local relayer, which must behave like a LayerZero Executor: an Executor
   * grants exactly the gas the sender's options asked for, and a call that exceeds it is mined
   * as a *failed* delivery rather than never being broadcast. Simulating first, or letting the
   * node pick the gas limit, would make under-provisioned options silently succeed and hide a
   * whole class of production failure.
   */
  async sendRaw(
    address: Address,
    abi: Abi,
    functionName: string,
    args: readonly unknown[] = [],
    opts: { value?: bigint; gas?: bigint } = {}
  ): Promise<TransactionReceipt> {
    const data = encodeFunctionData({ abi, functionName, args: args as never });
    const hash = await this.walletClient.sendTransaction({
      to: address,
      data,
      account: this.account,
      chain: this.walletClient.chain,
      ...(opts.value !== undefined ? { value: opts.value } : {}),
      ...(opts.gas !== undefined ? { gas: opts.gas } : {}),
    } as never);
    return this.publicClient.waitForTransactionReceipt({ hash });
  }

  /** Like {@link write}, but returns null instead of throwing. Used where a revert is expected. */
  async tryWrite(
    address: Address,
    abi: Abi,
    functionName: string,
    args: readonly unknown[] = [],
    value?: bigint
  ): Promise<{ receipt: TransactionReceipt | null; error?: string }> {
    try {
      return { receipt: await this.write(address, abi, functionName, args, value) };
    } catch (e) {
      return { receipt: null, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async read<T = unknown>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<T> {
    return (await this.publicClient.readContract({
      address,
      abi,
      functionName,
      args: args as never,
    })) as T;
  }

  /**
   * Gas limit for a write: the node's estimate plus a safety margin.
   *
   * A bare `eth_estimateGas` result is the minimum sufficient for the *simulated* state, and
   * writes whose cost is dominated by cold SSTOREs land close enough to that boundary to
   * revert once mined. That failure mode is particularly bad for a deployment pipeline: the
   * transaction does real work, runs out of gas at the tail, and leaves chain state half
   * changed while the pipeline reports a failure. See NOTES.md, M4.
   *
   * The margin is capped at the block gas limit so a large deployment still fits in a block.
   */
  private async gasWithMargin(estimate: () => Promise<bigint>): Promise<bigint> {
    const raw = await estimate();
    const padded = (raw * BigInt(Math.round(GAS_MARGIN * 100))) / 100n;
    const block = await this.publicClient.getBlock({ blockTag: "latest" });
    const ceiling = (block.gasLimit * 9n) / 10n;
    return padded > ceiling ? ceiling : padded;
  }

  async balance(address?: Address): Promise<bigint> {
    return this.publicClient.getBalance({ address: address ?? this.deployer });
  }

  async sendNative(to: Address, value: bigint): Promise<TransactionReceipt> {
    const hash = await this.walletClient.sendTransaction({
      to,
      value,
      account: this.account,
      chain: this.walletClient.chain,
    } as never);
    return this.publicClient.waitForTransactionReceipt({ hash });
  }

  /** Confirms the RPC is reachable and is actually the chain the config claims it is. */
  async preflight(): Promise<void> {
    const id = await this.publicClient.getChainId();
    if (id !== this.config.chainId) {
      throw new Error(
        `Chain id mismatch for "${this.key}": config says ${this.config.chainId}, RPC reports ${id}. ` +
          `Refusing to deploy — this is exactly how contracts end up on the wrong network.`
      );
    }
  }
}

export function buildChains(configs: ChainConfig[], privateKey?: Hex): Map<string, Chain> {
  const map = new Map<string, Chain>();
  for (const c of configs) map.set(c.key, new Chain(c, privateKey));
  return map;
}
