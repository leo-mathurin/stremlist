import { SITE } from "../content/site";
import { Link } from "react-router";
import NewsletterForm from "./NewsletterForm";
import { Button } from "@/components/ui/button";

const NAV_LINKS = [
  { label: "Terms", to: "/terms", internal: true },
  { label: "Changelog", to: "/changelog", internal: true },
  {
    label: "Source code",
    to: SITE.repository,
    internal: false,
  },
  { label: "Contact", to: `mailto:${SITE.contact}`, internal: false },
];

const COPYRIGHT_YEAR = new Date().getFullYear();

export default function Footer() {
  return (
    <footer className="mt-8 border-t border-black/10 pt-6">
      <NewsletterForm />

      <div className="mt-6 space-y-3 text-center">
        <nav className="flex flex-wrap items-center justify-center gap-x-1 gap-y-1">
          {NAV_LINKS.map((link, i) => (
            <span key={link.label} className="flex items-center">
              {i !== 0 && (
                <span className="text-black/20 select-none mx-2">·</span>
              )}
              <Button variant="link-muted" size="inline" asChild>
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
          <Button variant="link-muted" size="inline" asChild>
            <a
              href="https://ko-fi.com/lelemathrin"
              target="_blank"
              rel="noopener noreferrer"
            >
              ❤️ Buy me a coffee
            </a>
          </Button>
          <span className="text-black/20 select-none">·</span>
          <Button variant="link-muted" size="inline" asChild>
            <a href={SITE.author} target="_blank" rel="noopener noreferrer">
              Built by Léo Mathurin
            </a>
          </Button>
          <span className="text-black/20 select-none">·</span>
          <div className="w-50 shrink-0 overflow-hidden">
            <iframe
              src="https://status.stremlist.com/badge?theme=light"
              title="Stremlist Status"
              width={250}
              height={30}
              className="scheme-normal"
            />
          </div>
        </div>

        <p className="text-xs text-black/40">
          © {COPYRIGHT_YEAR} Stremlist. Not affiliated with Stremio, IMDb or any
          other list service. Logos are trademarks of their owners. IMDb and all
          related logos are trademarks of IMDb.com, Inc. or its affiliates.
        </p>
      </div>
    </footer>
  );
}
