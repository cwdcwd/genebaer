import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "genebaer",
  description: "Genetic algorithm runner with live visualizer",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen antialiased">
        <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
          <nav className="mx-auto flex h-13 max-w-7xl items-center gap-6 px-4 py-3">
            <Link href="/" className="flex items-baseline gap-1.5">
              <span className="text-lg font-bold tracking-tight text-accent">
                genebaer
              </span>
              <span className="text-[10px] uppercase tracking-widest text-muted">
                ga visualizer
              </span>
            </Link>
            <div className="flex items-center gap-1 text-sm">
              <NavLink href="/experiments/new">Experiments</NavLink>
              <NavLink href="/runs">Runs</NavLink>
            </div>
          </nav>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}

function NavLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="rounded-md px-3 py-1.5 text-muted transition-colors hover:bg-surface hover:text-foreground"
    >
      {children}
    </Link>
  );
}
