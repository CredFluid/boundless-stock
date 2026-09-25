/**
 * Partner access and fees: signing order authorisations, and applying a deployment's partner
 * configuration to every mirror chain.
 *
 * The EVM signing here is what a partner's backend runs to approve an order. It builds the same
 * EIP-712 digest `SwapRequest.hashPartnerOrder` does; scenario 10 checks the two agree.
 */
import { parseAbi, type Address, type Hex } from "viem";
import { authorizeEvmOrder } from "@boundless-stock/sdk";
import { PublicKey, type Keypair } from "@solana/web3.js";

import type { DeploymentConfig, Manifest } from "./types.js";
import type { Chain } from "./chains.js";
import { allChains, vmOf } from "./config.js";
import { SolanaSwapClient } from "../solana/client.js";
import { SolanaChain } from "../solana/chain.js";
import { log } from "./logger.js";

export const PARTNER_ABI = parseAbi([
  "struct PartnerAuth { uint32 partnerId; uint16 feeBps; uint256 nonce; uint256 deadline; bytes signature; }",
  "struct FeeEscrow { uint32 partnerId; uint8 state; address partnerRecipient; address platformRecipient; uint128 partnerFee; uint128 platformFee; }",
  "function buyVia(uint256 amountIn, uint256 minAmountOut, PartnerAuth auth) payable returns (uint64)",
  "function sellVia(uint256 amountIn, uint256 minAmountOut, PartnerAuth auth) payable returns (uint64)",
  "function hashPartnerOrder(address user, uint8 direction, uint256 amountIn, uint256 minAmountOut, uint32 partnerId, uint16 feeBps, uint256 nonce, uint256 deadline) view returns (bytes32)",
  "function setPartner(uint32 partnerId, address signer, address feeRecipient, uint16 maxFeeBps, bool active)",
  "function setPartnerRequired(bool required)",
  "function setPlatformFee(uint16 bps, address recipient)",
  "function partners(uint32) view returns (address signer, address feeRecipient, uint16 maxFeeBps, bool active)",
  "function partnerRequired() view returns (bool)",
  "function platformFeeBps() view returns (uint16)",
  "function platformFeeRecipient() view returns (address)",
  "function getFees(uint64 requestId) view returns (FeeEscrow)",
  "function feesClaimable(address token, address account) view returns (uint256)",
  "function feesReserved(address token) view returns (uint256)",
  "function claimFees(address token, address to) returns (uint256)",
  "function quoteFees(uint256 amountIn, uint16 partnerFeeBps) view returns (uint256 partnerFee, uint256 platformFee, uint256 net)",
]);

/** Mirrors `SwapRequest.FeeState`. */
export enum FeeState {
  NONE = 0,
  ESCROWED = 1,
  PAID = 2,
  RETURNED = 3,
}

export interface PartnerOrder {
  user: Address;
  direction: 0 | 1;
  amountIn: bigint;
  minAmountOut: bigint;
  partnerId: number;
  feeBps: number;
  nonce: bigint;
  deadline: bigint;
}

/**
 * A partner's EIP-712 authorisation of one order on one mirror chain's `SwapRequest`, via the
 * SDK's `authorizeEvmOrder` so there is one implementation of the digest.
 * @returns The `PartnerAuth` tuple `buyVia` / `sellVia` take.
 */
export async function signPartnerOrder(
  partnerKey: Hex,
  chainId: number,
  swapRequest: Address,
  o: PartnerOrder
): Promise<{ partnerId: number; feeBps: number; nonce: bigint; deadline: bigint; signature: Hex }> {
  const auth = await authorizeEvmOrder(
    partnerKey,
    { eip712: { name: "CrossStock SwapRequest", version: "1", chainId, verifyingContract: swapRequest } },
    {
      user: o.user,
      side: o.direction === 0 ? "buy" : "sell",
      amountIn: o.amountIn.toString(),
      minAmountOut: o.minAmountOut.toString(),
      partnerId: o.partnerId,
      feeBps: o.feeBps,
      nonce: o.nonce.toString(),
      deadline: o.deadline.toString(),
    }
  );
  return { partnerId: o.partnerId, feeBps: o.feeBps, nonce: o.nonce, deadline: o.deadline, signature: auth.signature as Hex };
}

/**
 * Applies `cfg.partners` to every mirror: registers or updates each partner, sets the platform
 * fee, and opens or closes the plain entrypoints. Idempotent — safe to re-run after editing the
 * config, which is how a partner is onboarded without redeploying anything.
 *
 * `required` is applied last, so a deployment is never closed before its partners exist.
 */
export async function applyPartners(
  cfg: DeploymentConfig,
  manifest: Manifest,
  evm: Map<string, Chain>,
  solana: { client: SolanaSwapClient; admin: Keypair }[]
): Promise<void> {
  const p = cfg.partners;
  if (!p) return;
  const list = p.partners ?? [];

  for (const [key, c] of Object.entries(manifest.chains)) {
    if (c.role !== "mirror") continue;
    const chain = evm.get(key);
    const request = c.contracts.SwapRequest as Address | undefined;
    if (!chain || !request) continue;
    for (const partner of list) {
      if (!partner.evm) continue;
      await chain.write(request, PARTNER_ABI, "setPartner", [
        partner.id,
        partner.evm.signer as Address,
        partner.evm.feeRecipient as Address,
        partner.maxFeeBps,
        partner.active ?? true,
      ]);
      log.ok(`${chain.name}: partner ${partner.id} (${partner.name}) set, up to ${partner.maxFeeBps} bps`);
    }
    if (p.platformFee) {
      const recipient = (p.platformFee.recipient.evm ?? "0x0000000000000000000000000000000000000000") as Address;
      await chain.write(request, PARTNER_ABI, "setPlatformFee", [p.platformFee.bps, recipient]);
      log.ok(`${chain.name}: platform fee ${p.platformFee.bps} bps`);
    }
    await chain.write(request, PARTNER_ABI, "setPartnerRequired", [p.required ?? false]);
    log.ok(`${chain.name}: partners ${p.required ? "required" : "optional"}`);
  }

  for (const { client, admin } of solana) {
    const name = client.chain.config.name;
    for (const partner of list) {
      if (!partner.svm) continue;
      await client.setPartner(admin, partner.id, {
        signer: new PublicKey(partner.svm.signer),
        feeRecipient: new PublicKey(partner.svm.feeRecipient),
        maxFeeBps: partner.maxFeeBps,
        active: partner.active ?? true,
      });
      log.ok(`${name}: partner ${partner.id} (${partner.name}) set, up to ${partner.maxFeeBps} bps`);
    }
    if (p.platformFee) {
      const recipient = p.platformFee.recipient.svm ? new PublicKey(p.platformFee.recipient.svm) : PublicKey.default;
      await client.setPlatformFee(admin, p.platformFee.bps, recipient);
      log.ok(`${name}: platform fee ${p.platformFee.bps} bps`);
    }
    await client.setPartnerRequired(admin, p.required ?? false);
    log.ok(`${name}: partners ${p.required ? "required" : "optional"}`);
  }
}

/** {@link applyPartners} for a whole deployment: every EVM mirror and every Solana mirror. */
export async function applyPartnersForDeployment(
  cfg: DeploymentConfig,
  manifest: Manifest,
  evm: Map<string, Chain>
): Promise<void> {
  if (!cfg.partners) return;
  log.step("Partners and fees");
  const solana = allChains(cfg)
    .filter((c) => vmOf(c) === "svm" && c.key !== cfg.homeChain.key)
    .map((c) => {
      const chain = new SolanaChain(c);
      return { client: new SolanaSwapClient(cfg, chain), admin: chain.payer };
    });
  await applyPartners(cfg, manifest, evm, solana);
}
