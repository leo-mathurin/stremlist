import { Link } from "react-router";
import { ArrowLeft } from "lucide-react";
import { Wordmark } from "./brand";

/**
 * The dark panel of a reading page (Terms, Changelog): the page title, a
 * table of contents on wide screens, and the way back Home.
 */
export default function DocPanel({
  title,
  lead,
  links,
}: {
  title: string;
  lead: string;
  links: { href: string; label: string; detail?: string }[];
}) {
  return (
    <div className="space-y-10">
      <Wordmark />
      <div>
        <h1 className="text-4xl font-bold tracking-tight text-balance sm:text-5xl">
          {title}
        </h1>
        <p className="mt-4 max-w-sm text-lg text-pretty text-white/65">
          {lead}
        </p>
      </div>
      <nav aria-label="On this page" className="-mx-3 hidden flex-col lg:flex">
        {links.map((link) => (
          <a
            key={link.href}
            href={link.href}
            className="flex items-baseline justify-between gap-4 rounded-xl px-3 py-2 text-white/70 transition-colors hover:bg-white/5 hover:text-cloud"
          >
            <span className="font-semibold">{link.label}</span>
            {link.detail && (
              <span className="text-xs text-white/40 tabular-nums">
                {link.detail}
              </span>
            )}
          </a>
        ))}
      </nav>
      <Link
        to="/"
        className="inline-flex items-center gap-2 rounded-full border border-white/25 px-5 py-2.5 text-sm font-semibold transition-[background-color,scale] duration-150 hover:bg-white/10 active:scale-[0.97]"
      >
        <ArrowLeft className="size-4" />
        Back to Home
      </Link>
    </div>
  );
}
