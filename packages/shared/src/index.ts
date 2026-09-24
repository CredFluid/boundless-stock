/**
 * Types shared across the monorepo.
 *
 * The deployment config and manifest types are defined once, beside the pipeline that writes
 * them (`infra/lib/types.ts`), and re-exported here so apps read exactly what the infra writes.
 * That file has no imports, so this pulls in no infra code.
 */
export type * from "../../../infra/lib/types";
export type * from "./solana";
