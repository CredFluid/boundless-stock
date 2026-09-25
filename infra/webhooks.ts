#!/usr/bin/env tsx
/**
 * Delivers order events to partners' webhooks.
 *
 * Polls the deployment's order history, and for every order placed through a partner that has
 * a webhook, turns each change of state into an event — filled, refunded, stranded, recovered
 * (a stranded order's return retried), cancelled — and POSTs it, signed, to that partner.
 *
 * Deliveries are at-least-once: an event is retried with backoff until the partner answers
 * 2xx, and survives restarts in `.crossstock/webhooks/`. Each event has a stable id, so a
 * partner deduplicates by it.
 *
 *   npm run webhooks -- --config config/localnet.json            # run continuously
 *   npm run webhooks -- --config config/localnet.json --once     # one pass, then exit
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { signWebhook, WEBHOOK_SIGNATURE_HEADER, type WebhookEvent, type WebhookEventType } from "@crossstock/sdk";

import { loadConfig } from "./lib/config.js";
import { repoRoot } from "./lib/root.js";
import type { DeploymentConfig, PartnerConfig } from "./lib/types.js";
import { syncHistory, type HistoryRecord } from "./history.js";
import { contextFromConfig, getOrder } from "./api/index.js";
import { log } from "./lib/logger.js";

const MAX_ATTEMPTS = 8;
const BASE_DELAY_MS = 5_000;

interface Delivery {
  event: WebhookEvent;
  partnerId: number;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
}

interface State {
  /** The last state each order was seen in: status, plus "held" for a stranded order still held. */
  seen: Record<string, string>;
  outbox: Delivery[];
  /** Deliveries that exhausted their retries, kept for inspection and replay. */
  dead: Delivery[];
}

const statePath = (name: string) => resolve(repoRoot(), ".crossstock", "webhooks", `${name}.json`);

function loadState(name: string): State {
  const p = statePath(name);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as State) : { seen: {}, outbox: [], dead: [] };
}

function saveState(name: string, s: State): void {
  mkdirSync(dirname(statePath(name)), { recursive: true });
  writeFileSync(statePath(name), JSON.stringify(s, null, 2) + "\n");
}

/** The state an order is in, for change detection; stranded splits on whether value is still held. */
const stateOf = (r: HistoryRecord) =>
  r.status === "stranded" ? (r.strandedHeld && r.strandedHeld !== "0" ? "stranded" : "recovered") : r.status;

const EVENT: Record<string, WebhookEventType | undefined> = {
  filled: "order.filled",
  refunded: "order.refunded",
  stranded: "order.stranded",
  recovered: "order.recovered",
  cancelled: "order.cancelled",
};

/** One pass: detect changes, queue their events, and attempt every delivery that is due. */
export async function webhookPass(cfg: DeploymentConfig): Promise<{ queued: number; delivered: number; failed: number }> {
  const partners = new Map<number, PartnerConfig>((cfg.partners?.partners ?? []).filter((p) => p.webhook).map((p) => [p.id, p]));
  const ctx = contextFromConfig(cfg);
  const state = loadState(cfg.name);
  const history = await syncHistory(cfg, ctx.manifest, ctx.evm);

  let queued = 0;
  for (const r of history.records) {
    if (r.partnerId === undefined || !partners.has(r.partnerId)) continue;
    const now = stateOf(r);
    if (state.seen[r.key] === now) continue;
    state.seen[r.key] = now;
    const type = EVENT[now];
    if (!type) continue; // pending: nothing to announce yet
    const order = await getOrder(ctx, r.chainKey, r.id);
    state.outbox.push({
      event: { id: `${cfg.name}:${r.key}:${now}`, type, createdAt: new Date().toISOString(), order },
      partnerId: r.partnerId,
      attempts: 0,
      nextAttemptAt: 0,
    });
    queued++;
  }

  let delivered = 0;
  let failed = 0;
  const remaining: Delivery[] = [];
  for (const d of state.outbox) {
    if (d.nextAttemptAt > Date.now()) {
      remaining.push(d);
      continue;
    }
    const partner = partners.get(d.partnerId);
    const secret = partner?.webhook ? process.env[partner.webhook.secretEnv] : undefined;
    if (!partner?.webhook || !secret) {
      d.lastError = partner?.webhook ? `${partner.webhook.secretEnv} is not set` : "partner has no webhook";
      state.dead.push(d);
      failed++;
      continue;
    }
    const body = JSON.stringify(d.event);
    d.attempts++;
    try {
      const res = await fetch(partner.webhook.url, {
        method: "POST",
        headers: { "content-type": "application/json", [WEBHOOK_SIGNATURE_HEADER]: signWebhook(body, secret), "x-crossstock-event-id": d.event.id },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        delivered++;
        log.ok(`${d.event.type} ${d.event.order.chain}#${d.event.order.id} → partner ${d.partnerId}`);
        continue;
      }
      d.lastError = `HTTP ${res.status}`;
    } catch (e) {
      d.lastError = e instanceof Error ? e.message : String(e);
    }
    failed++;
    if (d.attempts >= MAX_ATTEMPTS) {
      state.dead.push(d);
      log.fail(`${d.event.id} to partner ${d.partnerId}: giving up after ${d.attempts} attempts (${d.lastError})`);
    } else {
      d.nextAttemptAt = Date.now() + BASE_DELAY_MS * 2 ** (d.attempts - 1);
      remaining.push(d);
      log.warn(`${d.event.id} to partner ${d.partnerId}: ${d.lastError}; retrying`);
    }
  }
  state.outbox = remaining;
  saveState(cfg.name, state);
  return { queued, delivered, failed };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const cfg = loadConfig(arg("config") ?? "config/localnet.json");
  const withHooks = (cfg.partners?.partners ?? []).filter((p) => p.webhook);
  if (withHooks.length === 0) throw new Error(`No partner in ${cfg.name}'s config has a webhook.`);
  log.banner(`Webhooks — ${cfg.name}`);
  for (const p of withHooks) log.kv(`partner ${p.id}`, `${p.name} → ${p.webhook!.url}`);

  const interval = Number(arg("interval") ?? 5_000);
  for (;;) {
    const r = await webhookPass(cfg);
    if (r.queued || r.delivered || r.failed) log.dim(`queued ${r.queued}, delivered ${r.delivered}, failed ${r.failed}`);
    if (process.argv.includes("--once")) break;
    await new Promise((res) => setTimeout(res, interval));
  }
}

if (process.argv[1]?.endsWith("webhooks.ts")) {
  main().catch((e) => {
    log.fail(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
