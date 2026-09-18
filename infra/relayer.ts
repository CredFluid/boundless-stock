#!/usr/bin/env tsx
/**
 * Local LayerZero packet relayer.
 *
 * Stands in for LayerZero's off-chain DVN + Executor on the local chain set, performing the
 * exact same three steps they perform in production:
 *
 *   1. observe `PacketSent` on the source endpoint,
 *   2. verify the packet on the destination endpoint (the DVN's job),
 *   3. execute `lzReceive`, then drain any `ComposeSent` the delivery produced by calling
 *      `lzCompose` (the Executor's job).
 *
 * It does not simplify or shortcut the protocol — the packet is the real PacketV1 wire format,
 * the endpoint enforces real nonce ordering and payload hashing, and the gas and native value
 * come from the executor options the sending contract actually built.
 *
 * Only used against a local chain set. On live testnets LayerZero's own infrastructure does
 * this and the relayer is not run at all.
 *
 *   npm run relayer -- --config config/localnet.json --watch
 */
import { parseAbi, type Address, type Hex, type Log } from "viem";
import { loadConfig, allChains } from "./lib/config.js";
import { Chain, buildChains } from "./lib/chains.js";
import { loadManifest } from "./lib/manifest.js";
import { fromBytes32 } from "./lib/address.js";
import { log } from "./lib/logger.js";
import type { Manifest } from "./lib/types.js";

const ENDPOINT_ABI = parseAbi([
  "event PacketSent(bytes encodedPayload, bytes options, address sendLibrary)",
  "event ComposeSent(address from, address to, bytes32 guid, uint16 index, bytes message)",
  "event PacketDelivered((uint32 srcEid, bytes32 sender, uint64 nonce) origin, address receiver)",
  "function lzReceive((uint32 srcEid, bytes32 sender, uint64 nonce) _origin, address _receiver, bytes32 _guid, bytes _message, bytes _extraData) payable",
  "function lzCompose(address _from, address _to, bytes32 _guid, uint16 _index, bytes _message, bytes _extraData) payable",
]);

const MESSAGE_LIB_ABI = parseAbi(["function validatePacket(bytes _packetBytes)"]);

/**
 * Gas the endpoint itself consumes around the call, on top of what the OApp's options request.
 * A real Executor budgets similarly; the requested figure covers the OApp's own execution.
 */
const EXECUTOR_OVERHEAD = 120_000n;

// --------------------------------------------------------------------------- packet codec

export interface DecodedPacket {
  version: number;
  nonce: bigint;
  srcEid: number;
  sender: Hex;
  dstEid: number;
  receiver: Hex;
  guid: Hex;
  message: Hex;
}

/** Mirrors PacketV1Codec's byte offsets exactly. */
export function decodePacket(encoded: Hex): DecodedPacket {
  const b = encoded.slice(2);
  const at = (start: number, end: number): string => b.slice(start * 2, end * 2);
  return {
    version: parseInt(at(0, 1), 16),
    nonce: BigInt(`0x${at(1, 9)}`),
    srcEid: parseInt(at(9, 13), 16),
    sender: `0x${at(13, 45)}`,
    dstEid: parseInt(at(45, 49), 16),
    receiver: `0x${at(49, 81)}`,
    guid: `0x${at(81, 113)}`,
    message: `0x${b.slice(113 * 2)}`,
  };
}

export interface ExecutorRequests {
  lzReceiveGas: bigint;
  lzReceiveValue: bigint;
  composeGas: Map<number, bigint>;
  composeValue: Map<number, bigint>;
  nativeDrop: bigint;
}

/**
 * Parses LayerZero TYPE_3 executor options.
 *
 * Layout: `0x0003` then repeated `[workerId:1][size:2][optionType:1][params:size-1]`.
 * Worker id 1 is the executor; other workers (DVNs) are skipped by size.
 */
export function parseExecutorOptions(options: Hex): ExecutorRequests {
  const out: ExecutorRequests = {
    lzReceiveGas: 0n,
    lzReceiveValue: 0n,
    composeGas: new Map(),
    composeValue: new Map(),
    nativeDrop: 0n,
  };
  const b = options.slice(2);
  if (b.length < 4 || parseInt(b.slice(0, 4), 16) !== 3) return out;

  let cur = 4; // nibble cursor, past the 2-byte type prefix
  while (cur + 6 <= b.length) {
    const workerId = parseInt(b.slice(cur, cur + 2), 16);
    const size = parseInt(b.slice(cur + 2, cur + 6), 16); // bytes, includes the type byte
    const bodyStart = cur + 6;
    const optionType = parseInt(b.slice(bodyStart, bodyStart + 2), 16);
    const params = b.slice(bodyStart + 2, bodyStart + size * 2);
    cur = bodyStart + size * 2;

    if (workerId !== 1) continue; // DVN options carry no gas/value for us to honour

    if (optionType === 1) {
      out.lzReceiveGas = BigInt(`0x${params.slice(0, 32)}`);
      if (params.length >= 64) out.lzReceiveValue = BigInt(`0x${params.slice(32, 64)}`);
    } else if (optionType === 3) {
      const index = parseInt(params.slice(0, 4), 16);
      out.composeGas.set(index, BigInt(`0x${params.slice(4, 36)}`));
      if (params.length >= 68) out.composeValue.set(index, BigInt(`0x${params.slice(36, 68)}`));
    } else if (optionType === 2) {
      out.nativeDrop += BigInt(`0x${params.slice(0, 32)}`);
    }
  }
  return out;
}

// --------------------------------------------------------------------------- relayer

interface Endpoint {
  chain: Chain;
  eid: number;
  endpoint: Address;
  messageLib: Address;
  cursor: bigint;
}

export interface RelayStats {
  delivered: number;
  composed: number;
  failed: number;
}

export class Relayer {
  private endpoints = new Map<number, Endpoint>();
  private seen = new Set<string>();
  /** Composes whose execution reverted. Kept so an operator can retry them with more gas. */
  private failedComposes: { eid: number; from: Address; to: Address; guid: Hex; index: number; message: Hex; value: bigint }[] = [];
  readonly stats: RelayStats = { delivered: 0, composed: 0, failed: 0 };
  verbose = true;

  constructor(private manifest: Manifest, chains: Map<string, Chain>) {
    for (const [key, cd] of Object.entries(manifest.chains)) {
      const chain = chains.get(key);
      if (!chain) continue;
      if (!cd.localMessageLib) {
        throw new Error(
          `Chain "${key}" has no local message library recorded. The relayer is only for local ` +
            `chain sets — on live testnets LayerZero's own DVN and Executor deliver packets.`
        );
      }
      this.endpoints.set(cd.eid, {
        chain,
        eid: cd.eid,
        endpoint: cd.lzEndpoint as Address,
        messageLib: cd.localMessageLib as Address,
        cursor: 0n,
      });
    }
  }


  /** Composes that were delivered but reverted, still sitting in the endpoint's queue. */
  get stuckComposes(): number {
    return this.failedComposes.length;
  }

  /**
   * Retries every compose that previously reverted, granting a caller-chosen gas limit.
   *
   * This is what an operator (or a keeper) would have to run to unstick a delivery that was
   * under-provisioned by the sender's options. LayerZero keeps the compose in its queue with
   * the payload hash intact, so the retry is permissionless — but nothing performs it
   * automatically. See validation scenario 4.
   */
  async retryFailedComposes(gas = 3_000_000n): Promise<{ retried: number; succeeded: number }> {
    const queue = this.failedComposes.splice(0);
    let succeeded = 0;

    for (const c of queue) {
      const ep = this.endpoints.get(c.eid)!;
      const receipt = await ep.chain.sendRaw(
        ep.endpoint,
        ENDPOINT_ABI,
        "lzCompose",
        [c.from, c.to, c.guid, c.index, c.message, "0x"],
        { value: c.value, gas }
      );
      if (receipt.status === "success") {
        succeeded++;
        this.stats.composed++;
      } else {
        this.failedComposes.push(c);
      }
    }
    return { retried: queue.length, succeeded };
  }

  /** Starts from the current head, ignoring anything already on chain. */
  async syncToHead(): Promise<void> {
    for (const ep of this.endpoints.values()) {
      ep.cursor = await ep.chain.publicClient.getBlockNumber();
    }
  }

  /** One pass over every chain. Returns how many packets were delivered. */
  async tick(): Promise<number> {
    let delivered = 0;
    for (const ep of this.endpoints.values()) {
      delivered += await this.drainChain(ep);
    }
    return delivered;
  }

  /**
   * Runs ticks until no chain produces a new packet.
   *
   * Necessary because one user action fans out into several hops: the order packet triggers a
   * compose on the home chain, which emits a return packet, which is only visible on the next
   * pass over that chain.
   */
  async drain(maxRounds = 20): Promise<RelayStats> {
    for (let i = 0; i < maxRounds; i++) {
      const n = await this.tick();
      if (n === 0) {
        // One more quiet pass guards against a packet landing between two chains' scans.
        if ((await this.tick()) === 0) break;
      }
    }
    return this.stats;
  }

  async watch(intervalMs = 1000): Promise<never> {
    log.info("relayer watching for packets (ctrl-c to stop)");
    for (;;) {
      try {
        await this.tick();
      } catch (e) {
        log.fail(`relayer tick failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  private async drainChain(ep: Endpoint): Promise<number> {
    const head = await ep.chain.publicClient.getBlockNumber();
    if (head <= ep.cursor) {
      if (this.verbose) log.dim(`scan eid ${ep.eid}: SKIP (head ${head} <= cursor ${ep.cursor})`);
      return 0;
    }

    const from = ep.cursor + 1n;
    const logs = await ep.chain.publicClient.getLogs({
      address: ep.endpoint,
      event: ENDPOINT_ABI[0],
      fromBlock: from,
      toBlock: head,
    });
    ep.cursor = head;

    if (this.verbose) log.dim(`scan eid ${ep.eid}: blocks ${from}-${head}, ${logs.length} PacketSent`);

    let count = 0;
    for (const entry of logs) {
      const id = `${entry.transactionHash}:${entry.logIndex}`;
      if (this.seen.has(id)) continue;
      this.seen.add(id);

      const { encodedPayload, options } = entry.args as { encodedPayload: Hex; options: Hex };
      try {
        await this.deliver(encodedPayload, options);
        count++;
      } catch (e) {
        this.stats.failed++;
        log.fail(`delivery failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
      }
    }
    return count;
  }

  private async deliver(encodedPacket: Hex, options: Hex): Promise<void> {
    const packet = decodePacket(encodedPacket);
    const dst = this.endpoints.get(packet.dstEid);
    if (!dst) {
      throw new Error(`No local chain for destination eid ${packet.dstEid}`);
    }
    const req = parseExecutorOptions(options);
    const receiver = fromBytes32(packet.receiver);

    // Step 1 — verification. In production this is the DVN attesting to the packet.
    await dst.chain.write(dst.messageLib, MESSAGE_LIB_ABI, "validatePacket", [encodedPacket]);

    // Step 2 — execution. In production this is the Executor calling lzReceive with exactly
    // the gas the sender's options requested, so that is what is granted here too.
    const receipt = await dst.chain.sendRaw(
      dst.endpoint,
      ENDPOINT_ABI,
      "lzReceive",
      [
        { srcEid: packet.srcEid, sender: packet.sender, nonce: packet.nonce },
        receiver,
        packet.guid,
        packet.message,
        "0x",
      ],
      {
        value: req.lzReceiveValue + req.nativeDrop,
        gas: req.lzReceiveGas > 0n ? req.lzReceiveGas + EXECUTOR_OVERHEAD : undefined,
      }
    );

    if (receipt.status !== "success") {
      this.stats.failed++;
      log.warn(
        `lzReceive FAILED ${packet.srcEid}→${packet.dstEid} nonce ${packet.nonce} to ${receiver} ` +
          `(gas granted ${req.lzReceiveGas}, used ${receipt.gasUsed}). Packet stays verified and retryable.`
      );
      return;
    }
    this.stats.delivered++;
    if (this.verbose) {
      log.dim(
        `packet ${packet.srcEid}→${packet.dstEid} nonce ${packet.nonce} delivered to ${receiver} ` +
          `(gas ${receipt.gasUsed})`
      );
    }

    // Step 3 — drain composes the delivery queued.
    await this.executeComposes(dst, receipt.logs, req);
  }

  private async executeComposes(dst: Endpoint, logs: Log[], req: ExecutorRequests): Promise<void> {
    const composeSent = await dst.chain.publicClient.getLogs({
      address: dst.endpoint,
      event: ENDPOINT_ABI[1],
      fromBlock: logs[0]?.blockNumber ?? undefined,
      toBlock: logs[0]?.blockNumber ?? undefined,
    });

    for (const entry of composeSent) {
      const a = entry.args as { from: Address; to: Address; guid: Hex; index: number; message: Hex };
      const id = `compose:${entry.transactionHash}:${entry.logIndex}`;
      if (this.seen.has(id)) continue;
      this.seen.add(id);

      const value = req.composeValue.get(a.index) ?? 0n;
      const grantedGas = req.composeGas.get(a.index) ?? 0n;

      const receipt = await dst.chain.sendRaw(
        dst.endpoint,
        ENDPOINT_ABI,
        "lzCompose",
        [a.from, a.to, a.guid, a.index, a.message, "0x"],
        { value, gas: grantedGas > 0n ? grantedGas + EXECUTOR_OVERHEAD : undefined }
      );

      if (receipt.status !== "success") {
        this.stats.failed++;
        // The compose stays in the endpoint's queue with its hash intact, so anyone can retry
        // it later with more gas. Nothing is lost, but nothing self-heals either — see
        // validation scenario 4.
        log.warn(
          `lzCompose FAILED on ${a.to} index ${a.index} (gas granted ${grantedGas}, used ` +
            `${receipt.gasUsed}). Compose remains queued and retryable.`
        );
        this.failedComposes.push({
          eid: dst.eid,
          from: a.from,
          to: a.to,
          guid: a.guid,
          index: a.index,
          message: a.message,
          value,
        });
        this.seen.delete(id);
        continue;
      }

      this.stats.composed++;
      if (this.verbose) {
        log.dim(`compose index ${a.index} executed on ${a.to} (gas ${receipt.gasUsed}, value ${value})`);
      }
    }
  }
}

export async function buildRelayer(configPath: string): Promise<Relayer> {
  const cfg = loadConfig(configPath);
  const manifest = loadManifest(cfg.name);
  if (!manifest) throw new Error(`No manifest for "${cfg.name}" — run the deployment first.`);
  const chains = buildChains(allChains(cfg));
  return new Relayer(manifest, chains);
}

// --------------------------------------------------------------------------- CLI

async function main(): Promise<void> {
  const i = process.argv.indexOf("--config");
  const configPath = i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : "config/localnet.json";
  const relayer = await buildRelayer(configPath);

  if (process.argv.includes("--watch")) {
    await relayer.watch();
  } else {
    const stats = await relayer.drain();
    log.ok(`drained: ${stats.delivered} delivered, ${stats.composed} composed, ${stats.failed} failed`);
  }
}

if (process.argv[1]?.endsWith("relayer.ts")) {
  main().catch((e) => {
    log.fail(e instanceof Error ? e.message : String(e));
    if (process.env.DEBUG) console.error(e);
    process.exit(1);
  });
}
