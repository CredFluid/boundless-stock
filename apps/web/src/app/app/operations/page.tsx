import { RotateCcw, Ban, Anchor } from "lucide-react";
import { Badge, Card, PageHeader } from "@/components/ui";
import { OperationsLive } from "@/components/live/operations-live";

export const metadata = { title: "Operations and controls" };

const ROLES = [
  { role: "Issuer", can: "Owns the asset and its configuration: distribution chains, partners, fees and the partner gate. Keeps the mint authority of an existing token.", where: "Solana · every distribution chain" },
  { role: "Market operator", can: "Cancels a transfer that can never arrive, and holds an order whose return can't be delivered.", where: "Solana" },
  { role: "Distribution partner", can: "Approves the orders of its own verified users, within its fee ceiling. Cannot touch funds.", where: "Each distribution chain" },
  { role: "Anyone", can: "Retries a held return. Pays only the fee; the funds can only go to the recorded user.", where: "Solana" },
];

const ACTIONS = [
  {
    icon: RotateCcw,
    title: "Retry a return",
    who: "Anyone",
    tone: "ok" as const,
    body: "Sends a held amount back to its origin chain as a refund, to the recorded user. A caller can only pay the fee, never redirect funds.",
    where: "swap_relay retry_return",
  },
  {
    icon: Ban,
    title: "Cancel a stuck message",
    who: "Market operator",
    tone: "warn" as const,
    body: "Proves on Solana that the transfer can never execute, then tells the origin chain to restore the user's funds.",
    where: "swap_relay cancel_stuck_inbound",
  },
  {
    icon: Anchor,
    title: "Hold an undeliverable order",
    who: "Market operator",
    tone: "warn" as const,
    body: "When a return can't be delivered, the order is closed on Solana, its funds are held safely, and the origin chain is told.",
    where: "swap_relay strand_compose",
  },
];

export default function Operations() {
  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <PageHeader
        eyebrow="Issuer console"
        title="Operations and controls"
        description="What needs attention across every asset and chain, who holds which role, and the recovery path for every state. Funds are never lost in any of them."
      />

      <OperationsLive />

      <Card>
        <div className="border-b border-line px-5 py-4">
          <h2 className="text-sm font-semibold">Roles</h2>
          <p className="mt-0.5 text-sm text-muted">Who can do what. Every role is enforced on chain, not by this console.</p>
        </div>
        <div className="divide-y divide-line">
          {ROLES.map((r) => (
            <div key={r.role} className="grid gap-1 px-5 py-3 text-sm md:grid-cols-[200px_1fr_220px] md:items-center md:gap-4">
              <span className="font-medium">{r.role}</span>
              <span className="text-muted">{r.can}</span>
              <span className="text-xs text-muted md:text-right">{r.where}</span>
            </div>
          ))}
        </div>
      </Card>

      <div>
        <h2 className="text-lg font-semibold">Recovery actions</h2>
        <p className="mt-1 text-sm text-muted">
          Each is enforced on chain, and each is limited to the role shown.
        </p>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          {ACTIONS.map((a) => (
            <Card key={a.title} className="flex flex-col p-5">
              <div className="flex items-center justify-between">
                <a.icon size={18} className="text-accent" aria-hidden />
                <Badge tone={a.tone}>{a.who}</Badge>
              </div>
              <h3 className="mt-4 font-semibold">{a.title}</h3>
              <p className="mt-2 flex-1 text-sm text-muted">{a.body}</p>
              <p className="mt-4 font-mono text-xs text-muted">{a.where}</p>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
