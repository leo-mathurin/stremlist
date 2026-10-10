import type { ReactNode } from "react";
import { Link } from "react-router";
import type { ProviderId } from "@stremlist/shared/providers";
import { PROVIDER_LOGOS } from "@/lib/list-sources";
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

export function Wordmark() {
  return (
    <Link
      to="/"
      className="flex w-fit items-center gap-2.5"
      aria-label="Stremlist home"
    >
      <Logo />
      <span className="text-2xl font-bold tracking-tight">Stremlist</span>
    </Link>
  );
}

/**
 * A Provider's official mark in a circle. `active` adds a brand ring (a
 * Connection, a detected link, a checked Provider); `tone` is the surface it
 * sits on, for the ring gap.
 */
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
  const logo = PROVIDER_LOGOS[provider];
  return (
    <span
      aria-hidden="true"
      style={{ backgroundColor: logo.background }}
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full ring-offset-2 transition-shadow",
        active ? "ring-2 ring-brand" : "ring-0",
        tone === "dark" ? "ring-offset-ink" : "ring-offset-white",
        className,
      )}
    >
      <img
        src={logo.src}
        alt=""
        width={64}
        height={64}
        loading="lazy"
        className={cn(
          "size-full",
          logo.background ? "object-contain p-[18%]" : "object-cover",
        )}
      />
    </span>
  );
}

const SITE_LINKS = [
  { label: "Terms", to: "/terms" },
  { label: "Changelog", to: "/changelog" },
];

/**
 * The C-ours split layout: a dark brand panel (sticky on wide screens) next
 * to the main column. On phones the panel stacks above the content. The
 * panel has the same width on every page, so moving between Home and
 * Configure does not shift the layout.
 */
export function SplitLayout({
  panel,
  children,
  siteLinksBelow = true,
}: {
  panel: ReactNode;
  children: ReactNode;
  /** Show the site links after the content (pages without a Footer). */
  siteLinksBelow?: boolean;
}) {
  return (
    <div className="grid min-h-screen bg-paper font-rounded text-ink lg:grid-cols-[minmax(340px,38%)_minmax(0,1fr)]">
      <div className="min-w-0 bg-ink text-cloud">
        <aside className="p-6 sm:p-8 lg:sticky lg:top-0 lg:max-h-screen lg:min-h-screen lg:overflow-y-auto lg:p-12">
          {panel}
        </aside>
      </div>
      <main className="min-w-0">
        {children}
        {siteLinksBelow && (
          <nav
            aria-label="Site"
            className="flex-wrap items-center gap-x-4 gap-y-2 text-xs flex border-t border-black/10 px-5 py-6 text-black/45 sm:px-8 lg:px-12"
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
            <span>
              Not affiliated with Stremio or any list service. Logos are
              trademarks of their owners. IMDb and all related logos are
              trademarks of IMDb.com, Inc. or its affiliates.
            </span>
          </nav>
        )}
      </main>
    </div>
  );
}

/**
 * A section title: a real heading with an optional lead line. Stremlist has
 * no small uppercase labels above sections; the heading itself names it.
 */
export function SectionHeading({
  id,
  title,
  lead,
  size = "lg",
  className,
}: {
  id?: string;
  title: ReactNode;
  lead?: ReactNode;
  size?: "md" | "lg";
  className?: string;
}) {
  return (
    <div className={className}>
      <h2
        id={id}
        className={cn(
          "font-bold tracking-tight text-balance",
          size === "lg" ? "text-2xl sm:text-3xl" : "text-xl",
        )}
      >
        {title}
      </h2>
      {lead && (
        <p className="mt-1.5 max-w-xl text-pretty text-black/55">{lead}</p>
      )}
    </div>
  );
}
