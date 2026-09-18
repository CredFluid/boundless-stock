import type { Address, Hex } from "viem";
import type { Manifest, PeerRecord } from "../lib/types.js";
import { Chain } from "../lib/chains.js";
import { forgeArtifact } from "../lib/artifacts.js";
import { upsertPeer, recordStep } from "../lib/manifest.js";
import { toBytes32, isZeroBytes32 } from "../lib/address.js";
import { log } from "../lib/logger.js";

export interface PeerNode {
  chainKey: string;
  chainName: string;
  eid: number;
  address: Address;
}

export type Topology = "mesh" | "star";

/**
 * MODULE 3 — peer wiring.
 *
 * Runs as one setup step across every configured chain pair, rather than a manual call per
 * pair. Two topologies are supported because the two contract families need different shapes:
 *
 *   mesh — every node peers with every other node. Used for the OFT, so the token can move
 *          between any two chains in the set, not only through the home chain.
 *   star — every spoke peers with the hub and vice versa. Used for the relay pair: a
 *          SwapRequest only ever talks to the home chain's SwapRelay.
 *
 * VERIFICATION IS THE POINT OF THIS MODULE. After every `setPeer()` the value is read back
 * from the chain and compared against what was written, before moving on to the next pair. A
 * peer that silently failed to land produces a deployment that looks complete and then drops
 * messages at runtime, which is expensive to debug and cheap to prevent.
 */
export async function wirePeers(opts: {
  kind: "oft" | "relay";
  nodes: PeerNode[];
  chains: Map<string, Chain>;
  manifest: Manifest;
  topology: Topology;
  hubKey?: string;
}): Promise<{ wired: number; verified: number; failures: PeerRecord[] }> {
  const { kind, nodes, chains, manifest, topology, hubKey } = opts;

  // Any OApp exposes setPeer/peers; TokenizedStock's ABI is a convenient source for it.
  const abi = forgeArtifact("TokenizedStock").abi;

  const pairs = buildPairs(nodes, topology, hubKey);
  log.info(`${kind}: ${pairs.length} directed peer links (${topology})`);

  let verified = 0;
  const failures: PeerRecord[] = [];

  for (const [from, to] of pairs) {
    const chain = chains.get(from.chainKey)!;
    const expected = toBytes32(to.address);

    const current = await chain.read<Hex>(from.address, abi, "peers", [to.eid]);
    let txHash: string | undefined;

    if (current.toLowerCase() === expected.toLowerCase()) {
      log.dim(`${from.chainName} → ${to.chainName} already wired, skipping write`);
    } else {
      if (!isZeroBytes32(current)) {
        // Overwriting a non-zero peer is legitimate on redeploy, but it silently repoints a
        // live path, so make it visible rather than letting it pass unremarked.
        log.warn(`${from.chainName} → eid ${to.eid} was pointing at ${current}; repointing`);
      }
      const receipt = await chain.write(from.address, abi, "setPeer", [to.eid, expected]);
      txHash = receipt.transactionHash;
    }

    // Read back from chain state — never assume the write landed.
    const actual = await chain.read<Hex>(from.address, abi, "peers", [to.eid]);
    const ok = actual.toLowerCase() === expected.toLowerCase();

    const record: PeerRecord = {
      kind,
      fromChain: from.chainKey,
      toChain: to.chainKey,
      toEid: to.eid,
      expected,
      actual,
      verified: ok,
      txHash,
    };
    upsertPeer(manifest, record);

    if (ok) {
      verified++;
      log.ok(`${from.chainName} → ${to.chainName} (eid ${to.eid}) verified`);
    } else {
      failures.push(record);
      log.fail(`${from.chainName} → ${to.chainName}: wrote ${expected}, chain returned ${actual}`);
    }
  }

  recordStep(
    manifest,
    `03-peers:${kind}`,
    failures.length === 0 ? "ok" : "failed",
    `${verified}/${pairs.length} verified`
  );

  return { wired: pairs.length, verified, failures };
}

function buildPairs(nodes: PeerNode[], topology: Topology, hubKey?: string): [PeerNode, PeerNode][] {
  const pairs: [PeerNode, PeerNode][] = [];

  if (topology === "mesh") {
    for (const a of nodes) {
      for (const b of nodes) {
        if (a.chainKey !== b.chainKey) pairs.push([a, b]);
      }
    }
    return pairs;
  }

  if (!hubKey) throw new Error("star topology requires a hubKey");
  const hub = nodes.find((n) => n.chainKey === hubKey);
  if (!hub) throw new Error(`star hub "${hubKey}" is not in the node list`);

  for (const spoke of nodes) {
    if (spoke.chainKey === hubKey) continue;
    pairs.push([hub, spoke]); // hub → spoke
    pairs.push([spoke, hub]); // spoke → hub
  }
  return pairs;
}

/**
 * Re-reads every peer link recorded in the manifest straight from chain state.
 * Used as an independent audit after a full run, and by the validation suite before it trusts
 * a deployment enough to send anything through it.
 */
export async function auditPeers(
  manifest: Manifest,
  chains: Map<string, Chain>
): Promise<{ ok: boolean; checked: number; broken: PeerRecord[] }> {
  const abi = forgeArtifact("TokenizedStock").abi;
  const broken: PeerRecord[] = [];

  for (const p of manifest.peers) {
    const chain = chains.get(p.fromChain);
    if (!chain) continue;
    const contractName = p.kind === "oft" ? "TokenizedStock" : sourceRelayName(manifest, p.fromChain);
    const address = manifest.chains[p.fromChain]?.contracts[contractName];
    if (!address) {
      broken.push({ ...p, verified: false, actual: "missing contract" });
      continue;
    }
    const actual = await chain.read<Hex>(address as Address, abi, "peers", [p.toEid]);
    if (actual.toLowerCase() !== p.expected.toLowerCase()) {
      broken.push({ ...p, verified: false, actual });
    }
  }

  return { ok: broken.length === 0, checked: manifest.peers.length, broken };
}

function sourceRelayName(manifest: Manifest, chainKey: string): string {
  return manifest.chains[chainKey]?.role === "home" ? "SwapRelay" : "SwapRequest";
}
