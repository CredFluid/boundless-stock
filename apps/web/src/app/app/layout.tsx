import type { ReactNode } from "react";
import { Logo } from "@/components/site-header";
import { AppNav } from "@/components/app-nav";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[232px_1fr]">
      <aside className="border-b border-line bg-surface md:sticky md:top-0 md:h-dvh md:border-r md:border-b-0">
        <div className="flex h-14 items-center px-4">
          <Logo />
        </div>
        <div className="px-3 pb-3 md:pb-6">
          <div className="hidden px-3 pb-2 text-xs font-medium uppercase tracking-wide text-muted md:block">Issuer console</div>
          <AppNav />
          <div className="mt-6 hidden rounded-lg border border-line px-3 py-2 text-xs text-muted md:block">
            <span className="font-medium text-fg">Local demo.</span> Solana and four distribution chains running locally, with real
            programs and contracts.
          </div>
        </div>
      </aside>
      <main className="min-w-0 px-4 py-8 md:px-8">{children}</main>
    </div>
  );
}
