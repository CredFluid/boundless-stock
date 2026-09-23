/**
 * LayerZero plumbing for a LOCAL Solana validator: the endpoint's own state, a test message
 * library, and each OApp's messaging paths.
 *
 * The Solana counterpart of `infra/modules/00-endpoints.ts`. On devnet and mainnet all of this
 * already exists — LayerZero administers the endpoint and its libraries, and a DVN + Executor
 * deliver. A local validator has only the endpoint *program*; its state starts empty, so no
 * message can be sent or verified until:
 *
 *   1. the endpoint is initialised — `init_endpoint` is permissionless on a fresh validator,
 *      so the local payer becomes its admin;
 *   2. LayerZero's `simple-messagelib` is initialised and registered, with the local relayer as
 *      its whitelisted caller. Its `validate_packet` verifies a packet straight into the
 *      endpoint, exactly as the EVM side's `LocalMessageLib.validatePacket` does;
 *   3. it is the default send and receive library for every remote eid;
 *   4. every OApp has its per-path accounts: nonce, send/receive library config, and the
 *      message library's own config. An OApp without these cannot send or receive on that path.
 *
 * Every step checks the account it would create first, so the whole thing is re-runnable.
 *
 * Instructions are built with LayerZero's own SDK (`@layerzerolabs/lz-solana-sdk-v2`) rather
 * than hand-encoded: the account lists for these are long, order-sensitive and version-specific,
 * and the SDK is generated from the same program source that is loaded onto the validator.
 */
import { PublicKey, Transaction } from "@solana/web3.js";
import { createUmi, createNoopSigner, publicKey, type RpcInterface } from "@metaplex-foundation/umi";
import { web3JsRpc } from "@metaplex-foundation/umi-rpc-web3js";
import { toWeb3JsInstruction } from "@metaplex-foundation/umi-web3js-adapters";
import { EndpointProgram, SimpleMessageLibProgram, MessageLibPDA } from "@layerzerolabs/lz-solana-sdk-v2/umi";

import type { SolanaChain } from "./chain.js";
import { log } from "../lib/logger.js";

/** LayerZero EndpointV2 on Solana. Same id on every cluster, and loaded at it locally. */
export const ENDPOINT_PROGRAM_ID = "76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6";
/** LayerZero's test message library, built from source with its default id. */
export const SIMPLE_MESSAGELIB_PROGRAM_ID = "6GsmxMTHAAiFKfemuM4zBjumTjNSX5CAiw4xSSXM2Toy";

type Wrapped = { instruction: Parameters<typeof toWeb3JsInstruction>[0] };

export interface LzLocal {
  endpoint: EndpointProgram.Endpoint;
  messageLib: SimpleMessageLibProgram.SimpleMessageLib;
  rpc: RpcInterface;
}

export function lzLocal(chain: SolanaChain): LzLocal {
  const rpc = createUmi().use(web3JsRpc(chain.config.rpcUrl, { commitment: chain.commitment })).rpc;
  return {
    endpoint: new EndpointProgram.Endpoint(publicKey(ENDPOINT_PROGRAM_ID)),
    messageLib: new SimpleMessageLibProgram.SimpleMessageLib(publicKey(SIMPLE_MESSAGELIB_PROGRAM_ID)),
    rpc,
  };
}

/** Sends SDK-built instructions as one transaction signed by the payer. */
async function send(chain: SolanaChain, ...ixs: Wrapped[]): Promise<string> {
  const tx = new Transaction();
  for (const w of ixs) tx.add(toWeb3JsInstruction(w.instruction));
  const sig = await chain.connection.sendTransaction(tx, [chain.payer]);
  await chain.connection.confirmTransaction(sig, chain.commitment);
  return sig;
}

async function exists(chain: SolanaChain, address: string | PublicKey): Promise<boolean> {
  return (await chain.accountInfo(address.toString())) !== null;
}

/**
 * Steps 1–3: the endpoint, the test library, and the defaults for every remote eid.
 * @param remoteEids Every other chain in the deployment.
 */
export async function initLocalEndpoint(chain: SolanaChain, remoteEids: number[]): Promise<void> {
  log.step("LayerZero endpoint (local)");
  const { endpoint, messageLib, rpc } = lzLocal(chain);
  const payer = createNoopSigner(publicKey(chain.payer.publicKey.toBase58()));
  const admin = payer.publicKey;

  if (!(await chain.isProgramDeployed(SIMPLE_MESSAGELIB_PROGRAM_ID))) {
    throw new Error(
      `simple-messagelib is not loaded at ${SIMPLE_MESSAGELIB_PROGRAM_ID}. Start the validator with ` +
        "`npm run solana:up`, which loads it alongside the endpoint."
    );
  }

  const [setting] = endpoint.pda.setting();
  if (!(await exists(chain, setting))) {
    await send(chain, endpoint.initEndpoint(payer, { eid: chain.eid, admin }));
    log.ok(`endpoint initialised: eid ${chain.eid}, admin ${admin}`);
  } else {
    log.dim("endpoint already initialised");
  }

  const [lib] = new MessageLibPDA(publicKey(SIMPLE_MESSAGELIB_PROGRAM_ID)).messageLib();
  if (!(await exists(chain, lib))) {
    await send(
      chain,
      messageLib.initSimpleMessageLib(payer, { admin, eid: chain.eid, nativeFee: 0, lzTokenFee: 0 }),
      // The relayer verifies packets as this caller. Locally the relayer and the payer are the
      // same key; on a shared validator they need not be.
      messageLib.setWhitelistCaller(payer, admin)
    );
    log.ok("simple-messagelib initialised; the relayer is its whitelisted caller");
  }

  const [libInfo] = endpoint.pda.messageLibraryInfo(lib);
  if (!(await exists(chain, libInfo))) {
    await send(chain, endpoint.registerLibrary(payer, { messageLibProgram: publicKey(SIMPLE_MESSAGELIB_PROGRAM_ID) }));
    log.ok("simple-messagelib registered with the endpoint");
  }

  for (const remote of remoteEids) {
    const params = { messageLibProgram: publicKey(SIMPLE_MESSAGELIB_PROGRAM_ID), remote };
    await send(
      chain,
      await endpoint.setDefaultSendLibrary(rpc, payer, params),
      await endpoint.setDefaultReceiveLibrary(rpc, payer, params)
    );
  }
  log.ok(`default send/receive library set for ${remoteEids.length} remote eid(s): ${remoteEids.join(", ")}`);
}

/**
 * Step 4: one OApp's accounts for one path.
 *
 * @param oapp       The OApp's identity PDA — an OFT store, or `swap_request`'s store.
 * @param remote     The remote chain's eid.
 * @param remoteOApp The peer on that chain, as LayerZero addresses it (32 bytes).
 */
export async function initOAppPath(
  chain: SolanaChain,
  oapp: string,
  remote: number,
  remoteOApp: Uint8Array
): Promise<void> {
  const { endpoint, messageLib } = lzLocal(chain);
  const delegate = createNoopSigner(publicKey(chain.payer.publicKey.toBase58()));
  const oappKey = publicKey(oapp);

  const pending: Wrapped[] = [];
  const [nonce] = endpoint.pda.nonce(oappKey, remote, remoteOApp);
  if (!(await exists(chain, nonce))) {
    pending.push(endpoint.initOAppNonce(delegate, { localOApp: oappKey, remote, remoteOApp }));
  }
  const [sendCfg] = endpoint.pda.sendLibraryConfig(oappKey, remote);
  if (!(await exists(chain, sendCfg))) {
    pending.push(endpoint.initOAppSendLibrary(delegate, { sender: oappKey, remote }));
  }
  const [recvCfg] = endpoint.pda.receiveLibraryConfig(oappKey, remote);
  if (!(await exists(chain, recvCfg))) {
    pending.push(endpoint.initOAppReceiveLibrary(delegate, { receiver: oappKey, remote }));
    // The message library's own per-path config. Created alongside the receive config, since
    // neither exists without the other on a path this function has not seen before.
    pending.push(
      endpoint.initOAppConfig({ delegate, payer: delegate.publicKey }, { msgLibSDK: messageLib, oapp: oappKey, remote })
    );
  }
  if (pending.length > 0) await send(chain, ...pending);
}
