import { RotateCcw, Ban, Anchor } from "lucide-react";
import { Badge, Card, PageHeader } from "@/components/ui";
import { OperationsLive } from "@/components/live/operations-live";

export const metadata = { title: "Operations" };

const ACTIONS = [
  {
    icon: RotateCcw,
    title: "Retry a return",
    who: "Anyone",
    tone: "ok" as const,
    body: "Sends a stranded amount back to its mirror as a refund, to the recorded user. A caller can only pay the fee — never redirect funds.",
    where: "EVM home: SwapRelay.retryReturn · Solana home: swap_relay retry_return",
  },
  {
    icon: Ban,
    title: "Cancel a stuck message",
    who: "Relay admin",
    tone: "warn" as const,
    body: "Proves on the home chain that the message can never execute (skip, or burn if verified), then tells the mirror to re-create the user's input.",
    where: "EVM home: SwapRelay.cancelStuckInbound · Solana home: swap_relay cancel_stuck_inbound",
  },
  {
    icon: Anchor,
    title: "Strand an order",
    who: "Relay admin · Solana home",
    tone: "warn" as const,
    body: "A Solana home cannot catch a failed return, so the order stays queued. Stranding consumes it, holds the input, and notifies the mirror.",
    where: "swap_relay strand_compose",
  },
];

export default function Operations() {
  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <PageHeader
        eyebrow="Issuer console"
        title="Operations"
        description="Where an operator sees what needs attention and acts on it. Funds are never lost in these states — every one has a recovery path."
      />

      <OperationsLive />

      <div>
        <h2 className="text-lg font-semibold">Recovery actions</h2>
        <p className="mt-1 text-sm text-muted">
          Each exists on chain today; running them from this console, with role checks, is phase 3.
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
