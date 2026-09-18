import { pad, getAddress, type Address, type Hex } from "viem";

/** LayerZero addresses everywhere are bytes32, left-padded — including on EVM chains. */
export const toBytes32 = (addr: Address): Hex => pad(getAddress(addr), { size: 32 });

/** Inverse of {@link toBytes32}. */
export const fromBytes32 = (b32: Hex): Address => getAddress(`0x${b32.slice(-40)}`);

export const ZERO_BYTES32: Hex = `0x${"0".repeat(64)}`;

export const isZeroBytes32 = (b32: Hex): boolean => /^0x0*$/.test(b32);
