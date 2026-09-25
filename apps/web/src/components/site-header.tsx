import Link from "next/link";

export function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
      <span aria-hidden className="grid h-7 w-7 place-items-center rounded-lg bg-accent text-sm font-bold text-accent-contrast">B</span>
      Boundless Stock
    </Link>
  );
}

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-bg/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
        <Logo />
        <nav className="flex items-center gap-1 text-sm">
          <Link href="/#platform" className="hidden rounded-md px-3 py-1.5 text-muted hover:text-fg sm:block">Platform</Link>
          <Link href="/trade" className="rounded-md px-3 py-1.5 text-muted hover:text-fg">Partner preview</Link>
          <Link href="/app" className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-contrast hover:opacity-90">Issuer console</Link>
        </nav>
      </div>
    </header>
  );
}
