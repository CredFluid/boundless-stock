import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  type Commitment,
  type AccountInfo,
} from "@solana/web3.js";

import type { ChainConfig } from "../lib/types.js";
import { log } from "../lib/logger.js";

/**
 * The **SVM** backend, alongside the EVM `Chain` in `infra/lib/chains.ts`.
 *
 * Deliberately not a subclass or a shared interface with the EVM one. The two VMs disagree
 * about almost everything a deployment touches: an EVM "contract" is bytecode at an address
 * derived from a nonce, a Solana program is an account owned by a loader with its state living
 * in separate PDAs; EVM addresses are 20 bytes, Solana's are 32. Forcing one interface over
 * both would mean an abstraction whose every method had a VM-shaped hole in it. The pipeline
 * routes on `ChainConfig.vm` instead, and each backend stays honest about its own model.
 *
 * What the two DO share is `eid`: LayerZero routes on it regardless of VM, which is why the
 * messaging layer needs no abstraction at all.
 */
export class SolanaChain {
  readonly config: ChainConfig;
  readonly connection: Connection;
  readonly payer: Keypair;
  readonly commitment: Commitment;

  constructor(config: ChainConfig) {
    if ((config.vm ?? "evm") !== "svm") {
      throw new Error(
        `Chain "${config.key}" is not a Solana chain. This is a routing bug — the pipeline ` +
          `should have dispatched it to the EVM backend.`
      );
    }
    if (!config.svm?.endpointProgramId) {
      throw new Error(`Chain "${config.key}" is missing svm.endpointProgramId.`);
    }

    this.config = config;
    this.commitment = config.svm.commitment ?? "confirmed";
    this.connection = new Connection(config.rpcUrl, this.commitment);
    this.payer = loadKeypair(config.svm.keypairPath);
  }

  get key(): string {
    return this.config.key;
  }
  get name(): string {
    return this.config.name;
  }
  get eid(): number {
    return this.config.eid;
  }
  get deployer(): string {
    return this.payer.publicKey.toBase58();
  }
  get endpointProgramId(): PublicKey {
    return new PublicKey(this.config.svm!.endpointProgramId);
  }

  /**
   * Confirms the cluster is reachable and that LayerZero's endpoint is actually **executable**
   * there.
   *
   * The EVM backend's preflight asserts the chain id, because deploying to the wrong network is
   * the mistake that matters there. The Solana equivalent is a program that is present but not
   * executable: `solana-test-validator --clone` (without `--clone-upgradeable-program`) copies
   * the account and leaves the programdata behind, producing something that looks right in a
   * block explorer and fails at the first CPI.
   */
  async preflight(): Promise<void> {
    const version = await this.connection.getVersion();
    if (!version["solana-core"]) {
      throw new Error(`RPC at ${this.config.rpcUrl} did not report a Solana version.`);
    }

    const endpoint = await this.connection.getAccountInfo(this.endpointProgramId);
    if (!endpoint) {
      throw new Error(
        `LayerZero EndpointV2 (${this.config.svm!.endpointProgramId}) is not present on ` +
          `${this.name}. For a local validator, start it with \`npm run solana:up\`.`
      );
    }
    if (!endpoint.executable) {
      throw new Error(
        `LayerZero EndpointV2 exists on ${this.name} but is NOT executable. It was probably ` +
          `cloned with --clone instead of --clone-upgradeable-program, which copies the ` +
          `account without its programdata.`
      );
    }
  }

  async balance(address?: string): Promise<bigint> {
    const key = address ? new PublicKey(address) : this.payer.publicKey;
    return BigInt(await this.connection.getBalance(key, this.commitment));
  }

  async accountInfo(address: string): Promise<AccountInfo<Buffer> | null> {
    return this.connection.getAccountInfo(new PublicKey(address), this.commitment);
  }

  /** True when an executable program lives at this address. */
  async isProgramDeployed(programId: string): Promise<boolean> {
    const info = await this.accountInfo(programId);
    return !!info?.executable;
  }

  /**
   * Deploys (or upgrades) a compiled program, returning its program id.
   *
   * Shells out to `solana program deploy` rather than reimplementing it. Deployment is not a
   * single transaction: the binary is chunked into a buffer account across many transactions,
   * then finalised, with retry and recovery logic for partially written buffers. The CLI is
   * the reference implementation of all of that, and rewriting it in TypeScript would be a
   * large amount of code whose only distinction would be being less well tested.
   *
   * @param soPath   Path to the compiled `.so`.
   * @param keypairPath Program keypair, so the id is stable across redeploys.
   */
  async deployProgram(soPath: string, keypairPath: string): Promise<string> {
    const so = resolve(process.cwd(), soPath);
    const kp = resolve(process.cwd(), keypairPath);
    if (!existsSync(so)) {
      throw new Error(`Program binary not found: ${so}\nRun \`npm run solana:build\` first.`);
    }
    if (!existsSync(kp)) {
      throw new Error(`Program keypair not found: ${kp}`);
    }

    const programId = execFileSync("solana-keygen", ["pubkey", kp], { encoding: "utf8" }).trim();

    execFileSync(
      "solana",
      [
        "program", "deploy", so,
        "--program-id", kp,
        "--url", this.config.rpcUrl,
        "--keypair", this.config.svm!.keypairPath!,
        "--commitment", this.commitment,
      ],
      { stdio: "pipe" }
    );

    if (!(await this.isProgramDeployed(programId))) {
      throw new Error(`Deployed ${soPath} but ${programId} is not executable afterwards.`);
    }
    return programId;
  }

  /** Tops the payer up. Local validators only; a real cluster ignores this. */
  async airdrop(sol: number): Promise<void> {
    try {
      const sig = await this.connection.requestAirdrop(this.payer.publicKey, sol * 1_000_000_000);
      await this.connection.confirmTransaction(sig, this.commitment);
    } catch {
      log.dim(`airdrop unavailable on ${this.name}; assuming the payer is already funded`);
    }
  }

  /**
   * A program-derived address.
   * @dev Solana's answer to a mapping: state is addressed by deterministic derivation rather
   *      than stored inside the program, which is also what lets the executor name an account
   *      before a delivery happens.
   */
  pda(seeds: (Buffer | Uint8Array)[], programId: string): PublicKey {
    return PublicKey.findProgramAddressSync(seeds, new PublicKey(programId))[0];
  }
}

/**
 * Loads a Solana keypair.
 *
 * Solana has no "private key hex in an env var" convention the way EVM tooling does — keys live
 * in JSON files the CLI writes — so the config names a path. `SOLANA_KEYPAIR_PATH` overrides it
 * for CI, and the CLI's default location is the last resort.
 */
export function loadKeypair(configuredPath?: string): Keypair {
  const candidates = [
    process.env.SOLANA_KEYPAIR_PATH,
    configuredPath,
    `${process.env.HOME}/.config/solana/id.json`,
  ].filter(Boolean) as string[];

  for (const path of candidates) {
    const abs = resolve(process.cwd(), path);
    if (existsSync(abs)) {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(abs, "utf8"))));
    }
  }
  throw new Error(
    `No Solana keypair found. Looked at: ${candidates.join(", ")}. ` +
      `Set svm.keypairPath in config, or SOLANA_KEYPAIR_PATH.`
  );
}
