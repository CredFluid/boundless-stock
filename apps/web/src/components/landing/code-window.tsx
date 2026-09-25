import type { ReactNode } from "react";

/** A terminal/editor frame for code on the landing page. */
export function CodeWindow({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-xl shadow-black/5">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-bad/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-warn/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-ok/70" />
        <span className="ml-2 font-mono text-xs text-muted">{title}</span>
      </div>
      <pre className="overflow-x-auto p-5 font-mono text-[12.5px] leading-6">{children}</pre>
    </div>
  );
}

/** Syntax colours, by role. */
export const K = ({ children }: { children: ReactNode }) => <span className="text-evm">{children}</span>;
export const S = ({ children }: { children: ReactNode }) => <span className="text-accent">{children}</span>;
export const C = ({ children }: { children: ReactNode }) => <span className="text-muted">{children}</span>;
export const N = ({ children }: { children: ReactNode }) => <span className="text-warn">{children}</span>;
