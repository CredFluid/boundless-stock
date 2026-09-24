"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutGrid, Rocket, LifeBuoy, ArrowLeftRight } from "lucide-react";
import { cx } from "./ui";

const ITEMS = [
  { href: "/app", label: "Deployments", icon: LayoutGrid, exact: true },
  { href: "/app/launch", label: "Launch an asset", icon: Rocket },
  { href: "/app/operations", label: "Operations", icon: LifeBuoy },
  { href: "/trade", label: "Trading app", icon: ArrowLeftRight },
];

export function AppNav() {
  const path = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto md:flex-col">
      {ITEMS.map(({ href, label, icon: Icon, exact }) => {
        const active = exact ? path === href || path.startsWith("/app/deployments") : path.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={cx(
              "flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-sm",
              active ? "bg-surface-2 font-medium text-fg" : "text-muted hover:bg-surface-2 hover:text-fg"
            )}
          >
            <Icon size={16} aria-hidden />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
