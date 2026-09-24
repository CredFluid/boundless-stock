import "server-only";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Manifest, PeerRecord, SolanaChainRecord } from "@crossstock/shared";

/**
 * Read model over the deployment records the infra writes to `deployments/`.
 *
 * Phase 1 of the frontend reads these files directly on the server: every figure the
 * dashboard shows is one the pipeline recorded, not a mock. Live chain state (balances,
 * supply, pending messages) arrives with the read API in phase 2 — see FRONTEND.md.
 */

export function repoRoot(): string {
  // `next dev` runs in apps/web; the records live at the monorepo root.
  const candidates = [process.env.CROSSSTOCK_ROOT, resolve(process.cwd(), "../.."), process.cwd()];
  for (const c of candidates) if (c && existsSync(resolve(c, "deployments"))) return c;
  return resolve(process.cwd(), "../..");
}

const deploymentsDir = () => resolve(repoRoot(), "deployments");

export type Vm = "evm" | "svm";

export interface ContractRef {
  label: string;
  address: string;
}

export interface ChainView {
  key: string;
  name: string;
  vm: Vm;
  role: "home" | "mirror";
  eid: number;
  chainId?: number;
  contracts: ContractRef[];
}

export interface DeploymentView {
  name: string;
  environment: "local" | "live";
  createdAt: string;
  updatedAt: string;
  token: Manifest["token"];
  quoteAsset: Manifest["quoteAsset"];
  mode: "launch" | "adapt";
  venue: "Uniswap V3" | "Orca Whirlpool";
  home: ChainView;
  mirrors: ChainView[];
  peers: { total: number; verified: number; records: PeerRecord[] };
  steps: Manifest["steps"];
  pool?: Manifest["pool"];
  initialPrice?: string;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Contract labels as a person would say them, in a stable order. */
const LABELS: Record<string, string> = {
  TokenizedStock: "Stock token",
  TokenizedStockOft: "Stock OFT",
  QuoteAsset: "Quote token",
  QuoteAssetOft: "Quote OFT",
  Pool: "Pool",
  SwapRelay: "Swap relay",
  SwapRequest: "Swap request",
  UniswapV3Factory: "Uniswap V3 factory",
  SwapRouter: "Swap router",
  NonfungiblePositionManager: "Position manager",
  WETH9: "WETH9",
};

function evmContracts(contracts: Record<string, string>): ContractRef[] {
  const seen = new Set<string>();
  const out: ContractRef[] = [];
  for (const [k, label] of Object.entries(LABELS)) {
    const a = contracts[k];
    // A launched token is its own OFT; list the address once.
    if (!a || seen.has(`${label.split(" ")[0]}:${a.toLowerCase()}`)) continue;
    seen.add(`${label.split(" ")[0]}:${a.toLowerCase()}`);
    out.push({ label, address: a });
  }
  for (const [k, a] of Object.entries(contracts)) if (!(k in LABELS)) out.push({ label: k, address: a });
  return out;
}

function solanaContracts(r: SolanaChainRecord): ContractRef[] {
  const out: ContractRef[] = [
    { label: `${r.assets.base.symbol} mint`, address: r.assets.base.mint },
    { label: `${r.assets.base.symbol} OFT store`, address: r.assets.base.oftStore },
    { label: `${r.assets.quote.symbol} mint`, address: r.assets.quote.mint },
    { label: `${r.assets.quote.symbol} OFT store`, address: r.assets.quote.oftStore },
  ];
  if (r.swapRequest) out.push({ label: "Swap request store", address: r.swapRequest.store });
  if (r.relay) out.push({ label: "Swap relay store", address: r.relay.store });
  if (r.pool) out.push({ label: "Whirlpool", address: r.pool.whirlpool });
  for (const [k, id] of Object.entries(r.programs)) out.push({ label: `Program: ${k}`, address: id });
  return out;
}

function solanaRecords(name: string): SolanaChainRecord[] {
  return readdirSync(deploymentsDir())
    .filter((f) => f.startsWith(`${name}.`) && f.endsWith(".solana.json"))
    .map((f) => readJson<SolanaChainRecord>(resolve(deploymentsDir(), f)));
}

function toView(m: Manifest): DeploymentView {
  const sol = solanaRecords(m.name);
  const evm: ChainView[] = Object.values(m.chains).map((c) => ({
    key: c.key,
    name: c.name,
    vm: "evm",
    role: c.role,
    eid: c.eid,
    chainId: c.chainId,
    contracts: evmContracts(c.contracts),
  }));
  const svm: ChainView[] = sol.map((r) => ({
    key: r.chain.key,
    name: r.chain.name,
    vm: "svm",
    role: r.chain.key === m.homeChainKey ? "home" : "mirror",
    eid: r.chain.eid,
    contracts: solanaContracts(r),
  }));
  const all = [...evm, ...svm];
  const home = all.find((c) => c.key === m.homeChainKey) ?? all[0];
  const homeSol = sol.find((r) => r.chain.key === m.homeChainKey);
  const homeEvm = m.chains[m.homeChainKey];
  const adapted = homeSol
    ? homeSol.assets.base.mode === "adapt" || homeSol.assets.quote.mode === "adapt"
    : !!homeEvm && (["TokenizedStock", "QuoteAsset"] as const).some((k) => {
        // Manifests from before the OFT handle was recorded separately have no `*Oft` entry:
        // the token was its own OFT, i.e. launched.
        const token = homeEvm.contracts[k]?.toLowerCase();
        const oft = (homeEvm.contracts[`${k}Oft`] ?? homeEvm.contracts[k])?.toLowerCase();
        return !!token && token !== oft;
      });

  return {
    name: m.name,
    environment: m.environment,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    token: m.token,
    quoteAsset: m.quoteAsset,
    mode: adapted ? "adapt" : "launch",
    venue: home.vm === "svm" ? "Orca Whirlpool" : "Uniswap V3",
    home,
    mirrors: all.filter((c) => c.key !== home.key).sort((a, b) => a.name.localeCompare(b.name)),
    peers: { total: m.peers.length, verified: m.peers.filter((p) => p.verified).length, records: m.peers },
    steps: m.steps,
    pool: m.pool,
    initialPrice: m.pool?.initialPrice,
  };
}

export function listDeployments(): DeploymentView[] {
  if (!existsSync(deploymentsDir())) return [];
  return readdirSync(deploymentsDir())
    .filter((f) => f.endsWith(".manifest.json"))
    .map((f) => toView(readJson<Manifest>(resolve(deploymentsDir(), f))))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getDeployment(name: string): DeploymentView | undefined {
  const path = resolve(deploymentsDir(), `${name}.manifest.json`);
  if (!/^[a-z0-9-]+$/i.test(name) || !existsSync(path)) return undefined;
  return toView(readJson<Manifest>(path));
}
