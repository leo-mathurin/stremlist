import { useId, useState } from "react";
import { useNavigate } from "react-router";
import { ArrowRight } from "lucide-react";
import { parseSourceLink } from "@stremlist/shared/providers";
import { detectedLinkHint, extractAccountKey } from "@/lib/list-sources";
import { cn } from "@/lib/utils";

/**
 * The Home entry: paste a list link to start a new Stremlist on Configure,
 * or paste an Addon URL to open an existing one.
 */
export default function HomeEntry() {
  const navigate = useNavigate();
  const linkId = useId();
  const addonId = useId();
  const [link, setLink] = useState("");
  const [addonUrl, setAddonUrl] = useState("");
  const [showExisting, setShowExisting] = useState(false);
  const [addonError, setAddonError] = useState<string | null>(null);

  const detected = parseSourceLink(link);
  const pastedAccount = extractAccountKey(link);
  const hint = (() => {
    if (!link.trim()) return null;
    if (pastedAccount && !detected) return "Addon URL detected";
    if (!detected) return "No supported site recognized yet.";
    return detectedLinkHint(detected);
  })();

  const start = () => {
    const trimmed = link.trim();
    if (pastedAccount && !detected) {
      navigate(`/configure?account=${encodeURIComponent(pastedAccount)}`);
      return;
    }
    navigate("/configure", trimmed ? { state: { link: trimmed } } : undefined);
  };

  const openExisting = () => {
    const key = extractAccountKey(addonUrl);
    if (!key) {
      setAddonError(
        "Paste the Addon URL that you installed in Stremio. It ends with /manifest.json.",
      );
      return;
    }
    navigate(`/configure?account=${encodeURIComponent(key)}`);
  };

  return (
    <div className="space-y-4">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          start();
        }}
      >
        <label htmlFor={linkId} className="sr-only">
          Paste a link to a watchlist or list
        </label>
        <div className="flex flex-col gap-2 rounded-3xl bg-white/10 p-1.5 ring-1 ring-transparent transition-shadow focus-within:ring-brand/60 sm:flex-row sm:items-center sm:rounded-full">
          <input
            id={linkId}
            value={link}
            onChange={(event) => setLink(event.target.value)}
            placeholder="Paste a link to a watchlist or list"
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent px-4 py-3 text-cloud outline-none placeholder:text-white/40"
          />
          <button
            type="submit"
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-full bg-brand px-6 py-3 font-bold text-black transition-[background-color,scale] duration-150 hover:bg-brand-dark active:scale-[0.97]"
          >
            {link.trim() ? "Add this list" : "Build my Stremlist"}
            <ArrowRight className="size-4" />
          </button>
        </div>
        <p
          aria-live="polite"
          className={cn(
            "mt-2 min-h-5 px-4 text-xs",
            detected || pastedAccount ? "text-brand" : "text-white/45",
          )}
        >
          {hint ??
            "IMDb, Trakt, MDBList, JustWatch and SensCritique links work. Or start empty and connect an account."}
        </p>
      </form>

      {showExisting ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            openExisting();
          }}
          className="space-y-2"
        >
          <label
            htmlFor={addonId}
            className="block px-1 text-sm font-semibold text-white/80"
          >
            Your Addon URL
          </label>
          <div className="flex gap-2">
            <input
              id={addonId}
              value={addonUrl}
              onChange={(event) => {
                setAddonUrl(event.target.value);
                setAddonError(null);
              }}
              placeholder="https://…/manifest.json"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              className="min-w-0 flex-1 rounded-full bg-white/10 px-4 py-2.5 text-sm text-cloud outline-none ring-1 ring-transparent placeholder:text-white/40 focus:ring-brand/60"
            />
            <button
              type="submit"
              className="shrink-0 rounded-full border border-white/25 px-5 py-2.5 text-sm font-semibold transition-colors hover:bg-white/10"
            >
              Open
            </button>
          </div>
          {addonError ? (
            <p role="alert" className="px-1 text-xs text-red-300">
              {addonError}
            </p>
          ) : (
            <p className="px-1 text-xs text-white/45">
              In Stremio, open the Stremlist addon and copy its URL, or use the
              Configure button there.
            </p>
          )}
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setShowExisting(true)}
          className="rounded-full border border-white/25 px-6 py-3 text-sm font-semibold transition-colors hover:bg-white/10"
        >
          I already have one
        </button>
      )}
    </div>
  );
}
