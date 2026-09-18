import type { Hex } from "viem";

/**
 * LayerZero TYPE_3 executor options, built in TypeScript.
 *
 * Wire format:
 *   0x0003 || [ workerId:1 | size:2 | optionType:1 | params:(size-1) ]...
 *
 * `size` counts the option type byte plus its params. Worker id 1 is the Executor.
 * Mirrors `OptionsBuilder.sol` so off-chain callers and on-chain contracts agree byte for byte.
 */

const TYPE_3 = "0003";
const WORKER_EXECUTOR = "01";

const OPTION_LZRECEIVE = "01";
const OPTION_NATIVE_DROP = "02";
const OPTION_LZCOMPOSE = "03";

const hex = (v: bigint, bytes: number): string => v.toString(16).padStart(bytes * 2, "0");

export class Options {
  private parts: string[] = [];

  static new(): Options {
    return new Options();
  }

  private push(optionType: string, params: string): this {
    const size = 1 + params.length / 2; // option type byte + params
    this.parts.push(WORKER_EXECUTOR + hex(BigInt(size), 2) + optionType + params);
    return this;
  }

  /** Gas (and optional native value) for the destination `lzReceive`. */
  addExecutorLzReceive(gas: bigint, value = 0n): this {
    const params = value === 0n ? hex(gas, 16) : hex(gas, 16) + hex(value, 16);
    return this.push(OPTION_LZRECEIVE, params);
  }

  /** Gas (and optional native value) for a composed call at `index`. */
  addExecutorLzCompose(index: number, gas: bigint, value = 0n): this {
    const head = hex(BigInt(index), 2) + hex(gas, 16);
    const params = value === 0n ? head : head + hex(value, 16);
    return this.push(OPTION_LZCOMPOSE, params);
  }

  /** Drop native gas to an address on the destination chain. */
  addExecutorNativeDrop(amount: bigint, receiver: Hex): this {
    return this.push(OPTION_NATIVE_DROP, hex(amount, 16) + receiver.slice(2).padStart(64, "0"));
  }

  build(): Hex {
    return `0x${TYPE_3}${this.parts.join("")}`;
  }
}
