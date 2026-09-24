import { parseEther, type Address } from "viem";
import type { DeploymentConfig, Manifest } from "../lib/types.js";
import { Chain } from "../lib/chains.js";
import { forgeArtifact } from "../lib/artifacts.js";
import { setContract, recordStep, getContract } from "../lib/manifest.js";
import { endpointOf } from "./00-endpoints.js";
import { wirePeers, type PeerNode } from "./03-peers.js";
import { reuse } from "../lib/reuse.js";
import { log } from "../lib/logger.js";

/**
 * MODULE 5 — relay contracts.
 *
 * SwapRelay on the home chain, SwapRequest on every mirror chain, then peer-wired by the same
 * module 3 used for the OFT mesh. Nothing about relay wiring is special-cased: it is a star
 * instead of a mesh, and that is the only difference.
 *
 * Gas and fee parameters are applied from config here rather than baked into the contracts, so
 * a chain with different gas economics is a config change.
 */
export async function deployRelays(
  cfg: DeploymentConfig,
  chains: Map<string, Chain>,
  manifest: Manifest
): Promise<{ relay: Address; requests: Record<string, Address> }> {
  log.step("Module 5 — relay contracts (SwapRelay + SwapRequest)");

  const home = chains.get(cfg.homeChain.key)!;
  const relayArtifact = forgeArtifact("SwapRelay");

  // ---------------------------------------------------------------- home: SwapRelay

  log.group(`${home.name} (home)`);
  const existingRelay = await reuse(manifest, home, home.key, "SwapRelay");
  const relay =
    existingRelay ??
    (await home.deploy(relayArtifact, [
      endpointOf(manifest, home.key),
      home.deployer,
      getContract(manifest, home.key, "TokenizedStock"),
      getContract(manifest, home.key, "TokenizedStockOft"),
      getContract(manifest, home.key, "QuoteAsset"),
      getContract(manifest, home.key, "QuoteAssetOft"),
      getContract(manifest, home.key, "SwapRouter"),
      cfg.pool.feeTier,
    ]));
  log.kv("SwapRelay", relay);
  setContract(manifest, home.key, "SwapRelay", relay);

  // A buffer, not the primary funding path: each inbound order forwards its own return-leg
  // value via lzCompose. The buffer only covers fee drift between quote and execution.
  // Only funded on first deployment — an incremental run must not keep topping it up.
  const buffer = parseEther(cfg.relay.relayNativeBuffer);
  if (!existingRelay && buffer > 0n) {
    await home.write(relay, relayArtifact.abi, "fundNative", [], buffer);
    log.kv("native buffer", `${cfg.relay.relayNativeBuffer} ETH`);
  }
  log.groupEnd();

  const requests = await deployMirrorRequests(cfg, chains, manifest);

  const tokenArtifact = forgeArtifact("TokenizedStock");
  for (const asset of ["TokenizedStockOft", "QuoteAssetOft"] as const) {
    await home.write(getContract(manifest, home.key, asset) as Address, tokenArtifact.abi, "setDelegate", [relay]);
  }
  log.ok("SwapRelay set as the home OFTs' LayerZero delegate (can cancel stuck inbound messages)");

  // ---------------------------------------------------------------- return gas per mirror

  for (const mc of cfg.mirrorChains) {
    await home.write(relay, relayArtifact.abi, "setReturnGas", [mc.eid, BigInt(cfg.relay.returnGas)]);
    await home.write(relay, relayArtifact.abi, "setReturnComposeGas", [
      mc.eid,
      BigInt(cfg.relay.returnComposeGas ?? cfg.relay.returnGas),
    ]);
  }
  log.ok(`return gas configured for ${cfg.mirrorChains.length} mirror chains`);

  // ---------------------------------------------------------------- peer wiring (star)

  log.group("peer wiring — relay pair (star, hub = home)");
  const nodes: PeerNode[] = [
    { chainKey: home.key, chainName: home.name, eid: home.eid, address: relay },
    ...cfg.mirrorChains.map((mc) => ({
      chainKey: mc.key,
      chainName: mc.name,
      eid: mc.eid,
      address: requests[mc.key],
    })),
  ];

  const result = await wirePeers({
    kind: "relay",
    label: "SwapRelay↔SwapRequest",
    nodes,
    chains,
    manifest,
    topology: "star",
    hubKey: home.key,
  });
  log.groupEnd();

  if (result.failures.length > 0) {
    recordStep(manifest, "05-relays", "failed", `${result.failures.length} unverified peer links`);
    throw new Error(`Relay peer wiring failed verification on ${result.failures.length} link(s).`);
  }

  recordStep(manifest, "05-relays", "ok", `relay + ${cfg.mirrorChains.length} requests, ${result.verified} links`);
  return { relay, requests };
}

/**
 * The mirror half of module 5: a SwapRequest on every mirror chain, pointed at the home chain's
 * relay by eid, with the gas it forwards and the role that lets it restore a cancelled input.
 *
 * Separate from the home half because it does not care what the home chain is: an EVM
 * SwapRelay and a Solana `swap_relay` are both just a peer at `cfg.homeChain.eid`.
 */
export async function deployMirrorRequests(
  cfg: DeploymentConfig,
  chains: Map<string, Chain>,
  manifest: Manifest
): Promise<Record<string, Address>> {
  const requestArtifact = forgeArtifact("SwapRequest");

  const requests: Record<string, Address> = {};

  for (const mc of cfg.mirrorChains) {
    const chain = chains.get(mc.key)!;
    log.group(`${mc.name} (mirror)`);

    const request =
      (await reuse(manifest, chain, mc.key, "SwapRequest")) ??
      (await chain.deploy(requestArtifact, [
        endpointOf(manifest, mc.key),
        chain.deployer,
        getContract(manifest, mc.key, "TokenizedStock"),
        getContract(manifest, mc.key, "TokenizedStockOft"),
        getContract(manifest, mc.key, "QuoteAsset"),
        getContract(manifest, mc.key, "QuoteAssetOft"),
        cfg.homeChain.eid,
      ]));
    log.kv("SwapRequest", request);

    await chain.write(request, requestArtifact.abi, "setGasParams", [
      BigInt(cfg.relay.homeLzReceiveGas),
      BigInt(cfg.relay.homeComposeGas),
      parseEther(cfg.relay.homeComposeValue),
    ]);
    log.kv("compose gas / value", `${cfg.relay.homeComposeGas} / ${cfg.relay.homeComposeValue} ETH`);

    setContract(manifest, mc.key, "SwapRequest", request);
    requests[mc.key] = request;
    log.groupEnd();
  }

  // ---------------------------------------------------------------- recovery roles

  // The relay must be each mirror OFT's recoveryMinter so it can restore an input whose
  // outbound message was killed, and the home OFTs' LayerZero delegate so it is authorised to
  // do the killing. Both are trusted roles; see agents.md §9.
  const tokenArtifact = forgeArtifact("TokenizedStock");
  for (const mc of cfg.mirrorChains) {
    const chain = chains.get(mc.key)!;
    for (const asset of ["TokenizedStock", "QuoteAsset"] as const) {
      await chain.write(getContract(manifest, mc.key, asset) as Address, tokenArtifact.abi, "setRecoveryMinter", [
        requests[mc.key],
      ]);
    }
  }
  log.ok("mirror OFTs will accept recovery credits from their SwapRequest");
  return requests;
}
