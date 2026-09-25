/**
 * SCENARIO 10 — orders through a partner, with fees, on an EVM mirror and a Solana mirror.
 *
 * The distribution model: a partner (a wallet, exchange or app) owns the user and their KYC,
 * and approves each order it sends. With partners required, nothing else gets in.
 *
 *   EVM mirror
 *     a. the plain `buy` entrypoint is closed
 *     b. the partner's off-chain EIP-712 signature matches the contract's own digest
 *     c. a partner buy fills; the user pays exactly what was authorised; the partner and the
 *        platform earn exactly their basis points, and the partner withdraws its share
 *     d. a partner buy that cannot fill is refunded IN FULL, fees included
 *     e. an authorisation issued for one user is refused for anyone else
 *   Solana mirror (when the deployment has one)
 *     f. the plain `open_request` is closed
 *     g. a partner-co-signed buy fills; `settle_fees` pays partner and platform exactly
 *     h. a partner buy that cannot fill is refunded, and `settle_fees` returns the fee
 *     i. a transaction co-signed by anyone but the partner's authoriser is refused
 *
 * The scenario registers its own test partner and restores the mirrors' previous partner
 * settings when it finishes, so it can run against any deployment without leaving it changed.
 */
import { hashTypedData, parseEther, parseUnits, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Keypair, PublicKey } from "@solana/web3.js";

import { Direction, Status, type Harness, type ScenarioResult, OFT_ABI } from "./harness.js";
import { Options } from "../lib/options.js";
import { forgeArtifact } from "../lib/artifacts.js";
import { FeeState, PARTNER_ABI, signPartnerOrder } from "../lib/partners.js";
import { Chain } from "../lib/chains.js";
import { SolanaDirection, SolanaFeeState, SolanaStatus, ataOf, type SolanaSwapClient } from "../solana/client.js";
import { log } from "../lib/logger.js";

const NAME = "10. Partner orders (gated entry, signed authorisation, fees kept only on a fill)";
const PARTNER_ID = 900;
const PARTNER_FEE_BPS = 50;
const PLATFORM_FEE_BPS = 10;

export async function scenario10(h: Harness): Promise<ScenarioResult> {
  log.banner("Scenario 10 — orders through a partner");
  const findings: string[] = [];
  const metrics: Record<string, string | number> = {};

  await evmMirror(h, findings, metrics);
  if (h.solana[0]) await solanaMirror(h, h.solana[0], findings, metrics);
  else log.dim("no Solana mirror in this deployment — Solana steps skipped");

  const passed = findings.length === 0;
  return {
    name: NAME,
    passed,
    detail: passed
      ? `gated entry held; fees earned only on fills and returned in full on refunds${h.solana[0] ? ", on EVM and Solana" : ""}`
      : findings.join("; "),
    metrics,
    findings,
  };
}

// ---------------------------------------------------------------------------- EVM

async function evmMirror(h: Harness, findings: string[], metrics: Record<string, string | number>): Promise<void> {
  const mirror = h.mirrorKeys[0];
  const where = h.name(mirror);
  const owner = h.chain(mirror); // the deployer owns SwapRequest
  const user = h.user(mirror);
  const request = h.addr(mirror, "SwapRequest");
  const quote = h.addr(mirror, "QuoteAsset");
  const abi = forgeArtifact("SwapRequest").abi; // carries the custom errors, so reverts decode by name

  const partnerKey = generatePrivateKey();
  const partner = privateKeyToAccount(partnerKey).address;
  const treasuryKey = generatePrivateKey();
  const treasury = privateKeyToAccount(treasuryKey).address;
  const platform = privateKeyToAccount(generatePrivateKey()).address;

  const prior = {
    required: await owner.read<boolean>(request, PARTNER_ABI, "partnerRequired"),
    bps: await owner.read<number>(request, PARTNER_ABI, "platformFeeBps"),
    recipient: await owner.read<Address>(request, PARTNER_ABI, "platformFeeRecipient"),
  };

  log.step(`EVM — ${where}: register partner ${PARTNER_ID}, platform fee ${PLATFORM_FEE_BPS} bps, partners required`);
  await owner.write(request, PARTNER_ABI, "setPartner", [PARTNER_ID, partner, treasury, 100, true]);
  await owner.write(request, PARTNER_ABI, "setPlatformFee", [PLATFORM_FEE_BPS, platform]);
  await owner.write(request, PARTNER_ABI, "setPartnerRequired", [true]);

  try {
    const spend = parseUnits("15000", h.quoteDecimals);
    await h.ensureUserFunded(mirror, spend * 2n, "QuoteAsset");
    const chainId = owner.config.chainId!;

    // a. the open door is shut
    log.step("a. plain buy() is refused");
    await user.write(quote, OFT_ABI, "approve", [request, spend]);
    const open = await user.tryWrite(request, abi, "buy", [spend, 1n], parseEther("0.1"));
    if (open.receipt) findings.push(`${where}: buy() went through with partners required`);
    else if (!open.error?.includes("PartnerRequired")) findings.push(`${where}: buy() failed, but not with PartnerRequired: ${open.error?.slice(0, 120)}`);
    else log.ok("refused: PartnerRequired");

    // b. the SDK's digest is the contract's digest
    log.step("b. off-chain EIP-712 digest matches the contract");
    const order = {
      user: user.account.address,
      direction: Direction.BUY as 0,
      amountIn: spend,
      minAmountOut: 1n,
      partnerId: PARTNER_ID,
      feeBps: PARTNER_FEE_BPS,
      nonce: BigInt(Date.now()),
      deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
    };
    const onChain = await user.read<Hex>(request, PARTNER_ABI, "hashPartnerOrder", [
      order.user, order.direction, order.amountIn, order.minAmountOut, order.partnerId, order.feeBps, order.nonce, order.deadline,
    ]);
    const offChain = hashTypedData({
      domain: { name: "CrossStock SwapRequest", version: "1", chainId, verifyingContract: request },
      types: {
        PartnerOrder: [
          { name: "user", type: "address" },
          { name: "direction", type: "uint8" },
          { name: "amountIn", type: "uint256" },
          { name: "minAmountOut", type: "uint256" },
          { name: "partnerId", type: "uint32" },
          { name: "feeBps", type: "uint16" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "PartnerOrder",
      message: order,
    });
    if (onChain !== offChain) findings.push(`${where}: EIP-712 digest mismatch (contract ${onChain}, SDK ${offChain})`);
    else log.ok(`digest ${onChain.slice(0, 18)}… agrees`);

    // c. a fill: exact debit, exact fees, partner withdraws
    log.step("c. partner buy fills; fees earned");
    const auth = await signPartnerOrder(partnerKey, chainId, request, order);
    const [partnerFee, platformFee] = await user.read<readonly [bigint, bigint, bigint]>(request, PARTNER_ABI, "quoteFees", [spend, PARTNER_FEE_BPS]);
    const before = await h.quoteBalance(mirror, user.account.address);
    const msgFee = await user.read<{ nativeFee: bigint }>(request, abi, "quoteTrade", [Direction.BUY, spend, 1n]);
    const id = await user.read<bigint>(request, abi, "nextRequestId");
    await user.write(request, abi, "buyVia", [spend, 1n, auth], msgFee.nativeFee);
    const debited = before - (await h.quoteBalance(mirror, user.account.address));
    if (debited !== spend) findings.push(`${where}: user debited ${debited}, authorised ${spend}`);
    await h.waitFor("the partner buy to settle", async () => Number((await h.getRequest(mirror, id)).status) !== Status.PENDING);
    const r = await h.getRequest(mirror, id);
    const fees = await user.read<{ state: number }>(request, PARTNER_ABI, "getFees", [id]);
    if (Number(r.status) !== Status.FILLED) findings.push(`${where}: partner buy settled ${Status[Number(r.status)]}, expected FILLED`);
    if (fees.state !== FeeState.PAID) findings.push(`${where}: fee state ${FeeState[fees.state]} after a fill, expected PAID`);
    const earned = await user.read<bigint>(request, PARTNER_ABI, "feesClaimable", [quote, treasury]);
    const platformEarned = await user.read<bigint>(request, PARTNER_ABI, "feesClaimable", [quote, platform]);
    if (earned !== partnerFee) findings.push(`${where}: partner earned ${earned}, expected ${partnerFee}`);
    if (platformEarned !== platformFee) findings.push(`${where}: platform earned ${platformEarned}, expected ${platformFee}`);
    log.kv("partner fee", h.fmtQuote(earned));
    log.kv("platform fee", h.fmtQuote(platformEarned));
    log.kv("traded", h.fmtQuote(r.amountIn));

    // The partner withdraws with its own key: fund it for gas, then claim.
    await owner.walletClient.sendTransaction({ to: treasury, value: parseEther("0.1"), account: owner.account, chain: owner.walletClient.chain });
    const treasuryChain = new Chain(owner.config, treasuryKey);
    await treasuryChain.write(request, PARTNER_ABI, "claimFees", [quote, treasury]);
    const claimed = await h.quoteBalance(mirror, treasury);
    if (claimed !== partnerFee) findings.push(`${where}: partner withdrew ${claimed}, expected ${partnerFee}`);
    else log.ok(`partner withdrew ${h.fmtQuote(claimed)}`);
    metrics["EVM partner fee"] = h.fmtQuote(partnerFee);
    metrics["EVM platform fee"] = h.fmtQuote(platformFee);

    // d. no fill, no fee
    log.step("d. partner buy that cannot fill — refunded in full");
    const refundOrder = { ...order, minAmountOut: parseUnits("1000000", h.tokenDecimals), nonce: order.nonce + 1n };
    const refundAuth = await signPartnerOrder(partnerKey, chainId, request, refundOrder);
    const beforeRefund = await h.quoteBalance(mirror, user.account.address);
    await user.write(quote, OFT_ABI, "approve", [request, spend]);
    const refundId = await user.read<bigint>(request, abi, "nextRequestId");
    const fee2 = await user.read<{ nativeFee: bigint }>(request, abi, "quoteTrade", [Direction.BUY, spend, refundOrder.minAmountOut]);
    await user.write(request, abi, "buyVia", [spend, refundOrder.minAmountOut, refundAuth], fee2.nativeFee);
    await h.waitFor("the refund to settle", async () => Number((await h.getRequest(mirror, refundId)).status) !== Status.PENDING);
    const rr = await h.getRequest(mirror, refundId);
    const back = await h.quoteBalance(mirror, user.account.address);
    const refundFees = await user.read<{ state: number }>(request, PARTNER_ABI, "getFees", [refundId]);
    if (Number(rr.status) !== Status.REFUNDED) findings.push(`${where}: expected REFUNDED, got ${Status[Number(rr.status)]}`);
    if (back !== beforeRefund) findings.push(`${where}: refund left the user ${beforeRefund - back} short (fees not returned?)`);
    if (refundFees.state !== FeeState.RETURNED) findings.push(`${where}: fee state ${FeeState[refundFees.state]} after a refund, expected RETURNED`);
    else log.ok(`user whole again: ${h.fmtQuote(back)}, fees returned`);

    // e. an authorisation belongs to its user
    log.step("e. another account cannot use the user's authorisation");
    const stranger = new Chain(owner.config, generatePrivateKey());
    const reuse = await stranger.tryWrite(request, abi, "buyVia", [spend, 1n, { ...auth, nonce: order.nonce + 2n }], msgFee.nativeFee);
    if (reuse.receipt) findings.push(`${where}: a stranger's buyVia with the user's authorisation succeeded`);
    else log.ok("refused");
  } finally {
    await owner.write(request, PARTNER_ABI, "setPartnerRequired", [prior.required]);
    await owner.write(request, PARTNER_ABI, "setPlatformFee", [prior.bps, prior.recipient]);
    await owner.write(request, PARTNER_ABI, "setPartner", [PARTNER_ID, partner, treasury, 100, false]);
    log.dim(`${where}: partner settings restored`);
  }
}

// ---------------------------------------------------------------------------- Solana

async function solanaMirror(
  h: Harness,
  sol: SolanaSwapClient,
  findings: string[],
  metrics: Record<string, string | number>
): Promise<void> {
  const where = sol.chain.config.name;
  const admin = sol.chain.payer; // the store admin
  const quoteDec = (await sol.mintSupply("quote")).decimals;
  const fmt = (n: bigint) => `${Number(n) / 10 ** quoteDec} ${h.quoteSymbol}`;
  const partnerSigner = Keypair.generate();
  const treasury = Keypair.generate().publicKey;
  const platform = Keypair.generate().publicKey;
  const prior = await sol.partnerSettings();

  log.step(`Solana — ${where}: register partner ${PARTNER_ID}, platform fee ${PLATFORM_FEE_BPS} bps, partners required`);
  const terms = { signer: partnerSigner.publicKey, feeRecipient: treasury, maxFeeBps: 100, active: true };
  await sol.setPartner(admin, PARTNER_ID, terms);
  await sol.setPlatformFee(admin, PLATFORM_FEE_BPS, platform);
  await sol.setPartnerRequired(admin, true);

  const relay = h.config.relay;
  const options = Options.new()
    .addExecutorLzReceive(BigInt(relay.homeLzReceiveGas))
    .addExecutorLzCompose(0, BigInt(relay.homeComposeGas), parseEther(relay.homeComposeValue))
    .build();

  try {
    const user = await sol.newUser();
    const userId = `0x${Buffer.from(user.publicKey.toBytes()).toString("hex")}` as const;
    const spend = parseUnits("15000", quoteDec);
    await h.bridgeFromHomeTo(sol.eid, userId, "QuoteAsset", parseUnits("30000", h.quoteDecimals));
    await h.waitFor("USDC to reach the Solana user", async () => (await sol.balance(user.publicKey, "quote")) >= spend * 2n);
    const settle = async (id: bigint) => {
      await h.waitFor(`request ${id} to settle`, async () => ((await sol.getRequest(id))?.status ?? SolanaStatus.Pending) !== SolanaStatus.Pending);
      return (await sol.getRequest(id))!;
    };
    const errorOf = (e: unknown) => `${e instanceof Error ? e.message : String(e)} ${JSON.stringify((e as { logs?: string[] }).logs ?? [])}`;

    // f. the open door is shut
    log.step("f. plain open_request is refused");
    try {
      await sol.openRequest(user, SolanaDirection.Buy, spend, 1n, options);
      findings.push(`${where}: open_request went through with partners required`);
    } catch (e) {
      if (!errorOf(e).includes("PartnerRequired")) findings.push(`${where}: open_request failed, but not with PartnerRequired`);
      else log.ok("refused: PartnerRequired");
    }

    // g. a fill: exact fees to exact recipients
    log.step("g. partner-co-signed buy fills; settle_fees pays partner and platform");
    const before = await sol.balance(user.publicKey, "quote");
    const { requestId } = await sol.openRequestViaPartner(user, partnerSigner, PARTNER_ID, PARTNER_FEE_BPS, SolanaDirection.Buy, spend, 1n, options);
    const debited = before - (await sol.balance(user.publicKey, "quote"));
    if (debited !== spend) findings.push(`${where}: user debited ${debited}, expected ${spend}`);
    const filled = await settle(requestId);
    if (filled.status !== SolanaStatus.Filled) findings.push(`${where}: partner buy settled ${SolanaStatus[filled.status]}, expected Filled`);
    await sol.settleFees(admin, requestId);
    const escrow = (await sol.getFeeEscrow(requestId))!;
    const expectPartner = (spend * BigInt(PARTNER_FEE_BPS)) / 10_000n;
    const expectPlatform = (spend * BigInt(PLATFORM_FEE_BPS)) / 10_000n;
    const toPartner = await balanceOfAta(sol, treasury);
    const toPlatform = await balanceOfAta(sol, platform);
    if (escrow.state !== SolanaFeeState.Paid) findings.push(`${where}: fee state ${SolanaFeeState[escrow.state]} after a fill, expected Paid`);
    if (toPartner !== expectPartner) findings.push(`${where}: partner received ${toPartner}, expected ${expectPartner}`);
    if (toPlatform !== expectPlatform) findings.push(`${where}: platform received ${toPlatform}, expected ${expectPlatform}`);
    log.kv("partner fee", fmt(toPartner));
    log.kv("platform fee", fmt(toPlatform));
    metrics["Solana partner fee"] = fmt(toPartner);

    // h. no fill, no fee
    log.step("h. partner buy that cannot fill — refunded, fee returned by settle_fees");
    const beforeRefund = await sol.balance(user.publicKey, "quote");
    const refund = await sol.openRequestViaPartner(
      user, partnerSigner, PARTNER_ID, PARTNER_FEE_BPS, SolanaDirection.Buy, spend, parseUnits("1000000", (await sol.mintSupply("base")).decimals), options
    );
    const refunded = await settle(refund.requestId);
    if (refunded.status !== SolanaStatus.Refunded) findings.push(`${where}: expected Refunded, got ${SolanaStatus[refunded.status]}`);
    await sol.settleFees(admin, refund.requestId);
    const back = await sol.balance(user.publicKey, "quote");
    if (back !== beforeRefund) findings.push(`${where}: refund left the user ${beforeRefund - back} short`);
    else log.ok(`user whole again: ${fmt(back)}`);
    if ((await sol.getFeeEscrow(refund.requestId))!.state !== SolanaFeeState.Returned) findings.push(`${where}: fee not marked Returned`);

    // i. only the partner's authoriser can co-sign
    log.step("i. a transaction co-signed by anyone else is refused");
    try {
      await sol.openRequestViaPartner(user, Keypair.generate(), PARTNER_ID, PARTNER_FEE_BPS, SolanaDirection.Buy, 1_000_000n, 1n, options);
      findings.push(`${where}: an order co-signed by a stranger went through`);
    } catch (e) {
      if (!errorOf(e).includes("InvalidPartnerSigner")) findings.push(`${where}: stranger's co-signature failed, but not with InvalidPartnerSigner`);
      else log.ok("refused: InvalidPartnerSigner");
    }
  } finally {
    await sol.setPartnerRequired(admin, prior.partnerRequired);
    await sol.setPlatformFee(admin, prior.platformFeeBps, prior.platformFeeRecipient);
    await sol.setPartner(admin, PARTNER_ID, { ...terms, active: false });
    log.dim(`${where}: partner settings restored`);
  }
}

async function balanceOfAta(sol: SolanaSwapClient, owner: PublicKey): Promise<bigint> {
  const ata = ataOf(owner, sol.quoteMint);
  if (!(await sol.chain.connection.getAccountInfo(ata))) return 0n;
  return BigInt((await sol.chain.connection.getTokenAccountBalance(ata)).value.amount);
}
