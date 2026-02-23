import { Link } from "react-router";
import NewsletterForm from "./NewsletterForm";
import { Button } from "@/components/ui/button";

const NAV_LINKS = [
  { label: "Terms", to: "/terms", internal: true },
  { label: "Changelog", to: "/changelog", internal: true },
  {
    label: "Source code",
    to: "https://github.com/leo-mathurin/stremlist",
    internal: false,
  },
  { label: "Contact", to: "mailto:me@leomathurin.com", internal: false },
];

export default function Footer() {
  return (
    <footer className="mt-8 pt-6 border-t border-gray-200">
      <NewsletterForm />

      <div className="mt-6 space-y-3 text-center">
        <nav className="flex flex-wrap items-center justify-center gap-x-1 gap-y-1">
          {NAV_LINKS.map((link, i) => (
            <span key={link.label} className="flex items-center">
              {i !== 0 && (
                <span className="text-gray-300 select-none mx-2">·</span>
              )}
              <Button
                variant="link"
                asChild
                className="h-auto p-0 text-sm text-gray-500 hover:text-stremlist"
              >
                {link.internal ? (
                  <Link to={link.to}>{link.label}</Link>
                ) : (
                  <a
                    href={link.to}
                    target={link.to.startsWith("mailto") ? undefined : "_blank"}
                    rel={
                      link.to.startsWith("mailto")
                        ? undefined
                        : "noopener noreferrer"
                    }
                  >
                    {link.label}
                  </a>
                )}
              </Button>
            </span>
          ))}
        </nav>

        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button
            variant="link"
            asChild
            className="h-auto p-0 text-sm text-gray-500 hover:text-stremlist"
          >
            <a
              href="https://ko-fi.com/lelemathrin"
              target="_blank"
              rel="noopener noreferrer"
            >
              ❤️ Buy me a coffee
            </a>
          </Button>
          <span className="text-gray-300 select-none">·</span>
          <div className="shrink-0 overflow-hidden" style={{ width: 200 }}>
            <iframe
              src="https://status.stremlist.com/badge?theme=light"
              title="Stremlist Status"
              width={250}
              height={30}
              style={{ colorScheme: "normal" }}
            />
          </div>
        </div>

        <p className="text-xs text-gray-400">
          © 2025 IMDb Watchlist for Stremio &mdash; not affiliated with IMDb or
          Stremio
        </p>
      </div>
    </footer>
  );
}
