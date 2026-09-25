import type {
  ApiErrorBody,
  BuildOrderRequest,
  BuiltOrder,
  DeploymentDescriptor,
  Order,
  OrderStatus,
  Quote,
  QuoteRequest,
} from "./types.js";

/** An error the API returned, with its machine-readable code (e.g. `partner_required`). */
export class BoundlessStockApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "BoundlessStockApiError";
  }
}

export interface ApiClientOptions {
  /** e.g. https://api.example.com — the host serving `/api/v1`. */
  baseUrl: string;
  apiKey?: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * The partner API, typed. Every method maps to one endpoint; amounts are strings of integer
 * base units, as in {@link Quote}.
 */
export class BoundlessStockApi {
  private readonly base: string;
  private readonly key?: string;
  private readonly http: typeof fetch;

  constructor(opts: ApiClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "") + "/api/v1";
    this.key = opts.apiKey;
    this.http = opts.fetch ?? fetch;
  }

  deployments(): Promise<{ deployments: { name: string; asset: string; environment: string }[] }> {
    return this.call("GET", "/deployments");
  }

  deployment(name: string): Promise<DeploymentDescriptor> {
    return this.call("GET", `/deployments/${encodeURIComponent(name)}`);
  }

  quote(req: QuoteRequest): Promise<Quote> {
    return this.call("POST", "/quote", req);
  }

  buildOrder(req: BuildOrderRequest): Promise<BuiltOrder> {
    return this.call("POST", "/orders", req);
  }

  order(deployment: string, chain: string, id: string): Promise<Order> {
    return this.call("GET", `/orders/${encodeURIComponent(deployment)}/${encodeURIComponent(chain)}/${encodeURIComponent(id)}`);
  }

  orders(
    deployment: string,
    q: { user: string; chain?: string; status?: OrderStatus; limit?: number }
  ): Promise<{ orders: Omit<Order, "next" | "fees">[]; unreachable: string[] }> {
    const params = new URLSearchParams({ deployment, user: q.user });
    if (q.chain) params.set("chain", q.chain);
    if (q.status) params.set("status", q.status);
    if (q.limit) params.set("limit", String(q.limit));
    return this.call("GET", `/orders?${params}`);
  }

  /** Polls an order until it leaves `pending`, or the timeout passes (then returns it pending). */
  async waitForOrder(
    deployment: string,
    chain: string,
    id: string,
    opts: { timeoutMs?: number; intervalMs?: number } = {}
  ): Promise<Order> {
    const deadline = Date.now() + (opts.timeoutMs ?? 180_000);
    for (;;) {
      const o = await this.order(deployment, chain, id);
      if (o.status !== "pending" || Date.now() > deadline) return o;
      await new Promise((r) => setTimeout(r, opts.intervalMs ?? 2_000));
    }
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await this.http(this.base + path, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(this.key ? { "x-api-key": this.key } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const e = (json as Partial<ApiErrorBody>).error;
      throw new BoundlessStockApiError(res.status, e?.code ?? "http_error", e?.message ?? `HTTP ${res.status}`);
    }
    return json as T;
  }
}
