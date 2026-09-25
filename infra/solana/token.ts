/**
 * The two SPL token programs, and which one a mint lives under.
 *
 * Every transfer, and every associated token account address, depends on the mint's program:
 * the same wallet and mint have a different associated account under Token-2022. So the
 * program is recorded per asset in the deployment file and threaded through everything that
 * names a token account.
 */
import { PublicKey, type Connection } from "@solana/web3.js";

export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/** The program recorded for an asset; files written before it was recorded are classic. */
export const programOf = (asset: { tokenProgram?: string }): PublicKey =>
  asset.tokenProgram ? new PublicKey(asset.tokenProgram) : TOKEN_PROGRAM;

/**
 * Token-2022 extensions the programs refuse, by type — the same list as
 * `swap_request::spl::REFUSED_EXTENSIONS`, checked here too so a deployment fails before it
 * sends anything rather than at `init_store`.
 */
export const REFUSED_EXTENSIONS: Record<number, string> = {
  1: "transfer fee",
  6: "default account state",
  9: "non-transferable",
  12: "permanent delegate",
  14: "transfer hook",
  16: "confidential transfer fee",
};

/** Extension types in a Token-2022 mint's TLV data (after the 165-byte base and type byte). */
export function mintExtensions(data: Buffer): number[] {
  const out: number[] = [];
  if (data.length <= 166) return out;
  for (let o = 166; o + 4 <= data.length; ) {
    const kind = data.readUInt16LE(o);
    const len = data.readUInt16LE(o + 2);
    if (kind === 0) break;
    out.push(kind);
    o += 4 + len;
  }
  return out;
}

/** A mint's program, refusing anything that is neither token program. */
export async function tokenProgramOfMint(connection: Connection, mint: PublicKey): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`no mint at ${mint.toBase58()}`);
  if (!info.owner.equals(TOKEN_PROGRAM) && !info.owner.equals(TOKEN_2022_PROGRAM)) {
    throw new Error(`${mint.toBase58()} is not a token mint (owner ${info.owner.toBase58()})`);
  }
  return info.owner;
}
