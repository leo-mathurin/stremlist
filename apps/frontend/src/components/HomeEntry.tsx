import { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ArrowRight, Loader2 } from "lucide-react";
import { parseSourceLink } from "@stremlist/shared/providers";
import type { ParsedSourceLink } from "@stremlist/shared/providers";
import { api } from "@/lib/api";
import { findLegacyInstall } from "@/lib/legacy-install";
import type { LegacyInstallLookup } from "@/lib/legacy-install";
import {
  detectedLinkHint,
  extractAccountKey,
  PASTE_LINK_PROMPT,
} from "@/lib/list-sources";
import { cn } from "@/lib/utils";

const legacyInstallLookup: LegacyInstallLookup = {
  // The same answer as the public configure page of that key.
  async exists(alias) {
    const res = await api[":accountKey"].config.$get({
      param: { accountKey: alias },
    });
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`Install check failed: ${res.status}`);
    return true;
  },
  async canonicalRef(input) {
    try {
      const res = await api.links.resolve.$post({ json: { input } });
      if (!res.ok) return null;
      const body = await res.json();
      return body.ok ? body.sourceRef : null;
    } catch {
      return null;
    }
  },
};

/**
 * The v1 install that answers to a pasted link, or `failed` when the check
 * could not tell.
 */
async function checkLegacyInstall(
  input: string,
  detected: ParsedSourceLink,
): Promise<{ install: string | null } | "failed"> {
  try {
    return {
      install: await findLegacyInstall(input, detected, legacyInstallLookup),
    };
  } catch {
    return "failed";
  }
}

/**
 * The Home entry: paste a list link to start a new Stremlist on Configure,
 * or paste an Addon URL to open an existing one. When a v1 install answers to
 * a pasted IMDb user ID, Home asks whether it is the user's before it opens
 * it: the ID can be someone else's.
 */
export default function HomeEntry() {
  const navigate = useNavigate();
  const linkId = useId();
  const addonId = useId();
  const [link, setLink] = useState("");
  const [addonUrl, setAddonUrl] = useState("");
  const [showExisting, setShowExisting] = useState(false);
  const [addonError, setAddonError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  /** A v1 install that answers to the pasted link, until the user chooses. */
  const [found, setFound] = useState<string | null>(null);
  const addonInput = useRef<HTMLInputElement>(null);

  // The Addon URL field shows after a click on "Open it": it takes focus.
  useEffect(() => {
    if (showExisting) addonInput.current?.focus();
  }, [showExisting]);

  const detected = parseSourceLink(link);
  const pastedAccount = extractAccountKey(link);
  const hint = (() => {
    if (!link.trim()) return null;
    if (pastedAccount && !detected) return "Addon URL detected";
    if (!detected) return "No supported site recognized yet.";
    return detectedLinkHint(detected);
  })();

  /** `state.entry` tells the configure page that Home found this install. */
  const openAccount = (key: string, state?: { entry: "home" }) => {
    void navigate(`/configure?account=${encodeURIComponent(key)}`, { state });
  };

  const start = async () => {
    const trimmed = link.trim();
    if (checking) return;
    if (pastedAccount && !detected) {
      openAccount(pastedAccount);
      return;
    }
    if (detected) {
      setChecking(true);
      setStartError(null);
      const check = await checkLegacyInstall(trimmed, detected);
      setChecking(false);
      if (check === "failed") {
        // Not knowing is not "no install": a new setup could duplicate it.
        setStartError(
          "Could not check for your existing Stremlist. Please try again.",
        );
        return;
      }
      if (check.install) {
        setFound(check.install);
        return;
      }
    }
    startNew();
  };

  const startNew = () => {
    const trimmed = link.trim();
    void navigate(
      "/configure",
      trimmed ? { state: { link: trimmed } } : undefined,
    );
  };

  const openExisting = () => {
    const key = extractAccountKey(addonUrl);
    if (!key) {
      setAddonError(
        "Paste the Addon URL that you installed in Stremio. It ends with /manifest.json.",
      );
      return;
    }
    void navigate(`/configure?account=${encodeURIComponent(key)}`);
  };

  return (
    <div className="space-y-5">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <label htmlFor={linkId} className="sr-only">
          {PASTE_LINK_PROMPT}
        </label>
        {/* Side by side only when the field still fits its whole prompt. */}
        <div className="@container">
          <div className="flex flex-col gap-1.5 rounded-[28px] bg-white/10 p-1.5 ring-1 ring-transparent transition-shadow focus-within:ring-brand/60 @[30rem]:flex-row @[30rem]:items-center @[30rem]:rounded-full">
            <input
              id={linkId}
              value={link}
              onChange={(event) => {
                setLink(event.target.value);
                setStartError(null);
                setFound(null);
              }}
              placeholder={PASTE_LINK_PROMPT}
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent px-4 py-3 text-cloud outline-none placeholder:text-white/40"
            />
            <button
              type="submit"
              aria-busy={checking}
              className="inline-flex shrink-0 items-center justify-center gap-2 rounded-full bg-brand px-6 py-3 font-bold text-black transition-[background-color,scale] duration-150 hover:bg-brand-dark active:scale-[0.97]"
            >
              {link.trim() ? "Add this list" : "Build my Stremlist"}
              {checking ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ArrowRight className="size-4" />
              )}
            </button>
          </div>
        </div>
        {found ? (
          <div
            role="group"
            aria-labelledby={`${linkId}-found`}
            className="mt-3 rounded-3xl bg-white/10 p-4"
          >
            <p id={`${linkId}-found`} className="font-semibold text-cloud">
              Is this your Stremlist?
            </p>
            <p className="mt-1 text-sm text-white/60">
              A Stremlist made before version 2 uses this IMDb ID. Open it if it
              is yours. Otherwise, start a new one.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => openAccount(found, { entry: "home" })}
                className="rounded-full bg-brand px-5 py-2.5 text-sm font-bold text-black transition-[background-color,scale] duration-150 hover:bg-brand-dark active:scale-[0.97]"
              >
                Open my Stremlist
              </button>
              <button
                type="button"
                onClick={startNew}
                className="rounded-full border border-white/25 px-5 py-2.5 text-sm font-semibold transition-colors hover:bg-white/10"
              >
                Start a new one
              </button>
            </div>
          </div>
        ) : startError ? (
          <p role="alert" className="mt-2 px-5.5 text-xs text-red-300">
            {startError}
          </p>
        ) : (
          <p
            aria-live="polite"
            className={cn(
              "mt-2 px-5.5 text-xs empty:mt-0",
              detected || pastedAccount ? "text-brand" : "text-white/45",
            )}
          >
            {hint}
          </p>
        )}
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
              ref={addonInput}
              id={addonId}
              value={addonUrl}
              onChange={(event) => {
                setAddonUrl(event.target.value);
                setAddonError(null);
              }}
              placeholder="https://…/manifest.json"
              autoComplete="off"
              spellCheck={false}
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
        <p className="text-sm text-white/50">
          Already have a Stremlist?{" "}
          <button
            type="button"
            onClick={() => setShowExisting(true)}
            className="font-semibold text-cloud underline decoration-white/30 underline-offset-4 transition-colors hover:decoration-brand"
          >
            Open it
          </button>
        </p>
      )}
    </div>
  );
}
