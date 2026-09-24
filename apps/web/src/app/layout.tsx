import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "CrossStock", template: "%s · CrossStock" },
  description: "Trade a tokenized stock from any chain — one market, every chain, no liquidity needed where you stand.",
};

/**
 * Turns scroll and entrance animations on — but only once JavaScript is running (so content
 * is never left hidden) and only for visitors who haven't asked for reduced motion.
 */
const MOTION_FLAG = `if(!matchMedia("(prefers-reduced-motion: reduce)").matches)document.documentElement.dataset.anim="on"`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: MOTION_FLAG }} />
      </head>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
