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
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ChainConfig } from "./types.js";
import type { Artifact } from "./artifacts.js";

/** Anvil's first default account. Used only when no DEPLOYER_PRIVATE_KEY is configured. */
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
    this.publicClient = createPublicClient({ chain, transport }) as PublicClient;
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
    const hash = await this.walletClient.writeContract(request as never);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`${functionName}() reverted on ${this.name} (tx ${hash}).`);
    }
    return receipt;
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
