import { Clock, RotateCcw, Ban, Anchor } from "lucide-react";
import { Badge, Card, CardHeader, PageHeader, PreviewNote } from "@/components/ui";

export const metadata = { title: "Operations" };

const QUEUES = [
  {
    title: "Pending requests",
    icon: Clock,
    body: "Orders sent from a mirror that have not settled yet. Normally seconds; anything older is worth a look.",
    columns: ["Request", "Mirror", "Direction", "Amount", "Age"],
  },
  {
    title: "Stranded returns",
    icon: Anchor,
    body: "Results the home relay holds because the return leg could not be sent. The mirror shows STRANDED; the funds are safe on the home chain.",
    columns: ["Request", "To mirror", "Asset", "Amount", "Stranded since"],
  },
  {
    title: "Stuck inbound messages",
    icon: Ban,
    body: "Orders whose message never reached the home chain. Cancelling kills the message there, then restores the user's input on the mirror.",
    columns: ["Mirror", "Path", "Nonce", "Verified?", "Age"],
  },
];

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

      <PreviewNote>
        The queues fill from the read API and indexer (phase 2). Until then, the same states surface in the validation suite
        and the relayer's logs; the actions below exist on chain today.
      </PreviewNote>

      <div className="grid gap-6">
        {QUEUES.map((q) => (
          <Card key={q.title}>
            <CardHeader title={q.title} subtitle={q.body} action={<q.icon size={18} className="text-muted" aria-hidden />} />
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-muted">
                  <tr className="border-b border-line">
                    {q.columns.map((c) => <th key={c} className="px-5 py-2 font-medium">{c}</th>)}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td colSpan={q.columns.length} className="px-5 py-8 text-center text-muted">
                      Nothing to show until a live data source is connected.
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>
        ))}
      </div>

      <div>
        <h2 className="text-lg font-semibold">Recovery actions</h2>
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
