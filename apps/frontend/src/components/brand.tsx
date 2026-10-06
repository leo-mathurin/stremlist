import type { ReactNode } from "react";
import { Link } from "react-router";
import type { ProviderId } from "@stremlist/shared/providers";
import { PROVIDER_MONOGRAMS } from "@/lib/list-sources";
import { cn } from "@/lib/utils";

export function Logo({ size = 34 }: { size?: number }) {
  return (
    <img
      src="/icon.png"
      alt=""
      width={size}
      height={size}
      className="shrink-0 rounded"
    />
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <Link
      to="/"
      className={cn("flex w-fit items-center gap-2.5", className)}
      aria-label="Stremlist home"
    >
      <Logo />
      <span className="text-2xl font-bold tracking-tight">Stremlist</span>
    </Link>
  );
}

/** A Provider's two-letter mark. `tone` follows the surface it sits on. */
export function ProviderMark({
  provider,
  tone = "light",
  active = false,
  className,
}: {
  provider: ProviderId;
  tone?: "light" | "dark";
  active?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold tracking-wide transition-colors",
        active
          ? "bg-brand text-black"
          : tone === "dark"
            ? "bg-white/10 text-cloud"
            : "bg-black/[0.06] text-ink",
        className,
      )}
    >
      {PROVIDER_MONOGRAMS[provider]}
    </span>
  );
}

const SITE_LINKS = [
  { label: "Terms", to: "/terms" },
  { label: "Changelog", to: "/changelog" },
];

function SiteLinks({ className }: { className?: string }) {
  return (
    <nav
      aria-label="Site"
      className={cn(
        "flex-wrap items-center gap-x-4 gap-y-2 text-xs",
        className,
      )}
    >
      {SITE_LINKS.map((link) => (
        <Link
          key={link.to}
          to={link.to}
          className="transition-colors hover:text-stremlist"
        >
          {link.label}
        </Link>
      ))}
      <a
        href="https://github.com/leo-mathurin/stremlist"
        target="_blank"
        rel="noopener noreferrer"
        className="transition-colors hover:text-stremlist"
      >
        Source code
      </a>
      <a
        href="mailto:me@leomathurin.com"
        className="transition-colors hover:text-stremlist"
      >
        Contact
      </a>
      <span>Not affiliated with Stremio or any list service.</span>
    </nav>
  );
}

/**
 * The C-ours split layout: a dark brand panel (sticky on wide screens) next
 * to the main column. On phones the panel stacks above the content.
 */
export function SplitLayout({
  panel,
  children,
  panelWidth = "wide",
  siteLinksBelow = true,
}: {
  panel: ReactNode;
  children: ReactNode;
  panelWidth?: "wide" | "narrow";
  /** On phones, repeat the site links after the content (no Footer there). */
  siteLinksBelow?: boolean;
}) {
  return (
    <div
      className={cn(
        "grid min-h-screen bg-paper font-rounded text-ink",
        panelWidth === "wide"
          ? "lg:grid-cols-[42%_minmax(0,1fr)]"
          : "lg:grid-cols-[minmax(340px,36%)_minmax(0,1fr)]",
      )}
    >
      <div className="min-w-0 bg-ink text-cloud">
        <aside className="flex flex-col justify-between gap-10 p-6 sm:p-8 lg:sticky lg:top-0 lg:max-h-screen lg:min-h-screen lg:overflow-y-auto lg:p-12">
          <div className="min-w-0">{panel}</div>
          <SiteLinks className="hidden text-white/45 lg:flex" />
        </aside>
      </div>
      <main className="min-w-0">
        {children}
        {siteLinksBelow && (
          <SiteLinks className="flex border-t border-black/10 px-5 py-6 text-black/45 sm:px-8 lg:hidden" />
        )}
      </main>
    </div>
  );
}

/** Small uppercase label above a section. */
export function Eyebrow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "text-xs font-semibold uppercase tracking-wider text-black/45",
        className,
      )}
    >
      {children}
    </p>
  );
}
