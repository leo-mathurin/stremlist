import { useEffect, useId, useRef, useState } from "react";
import { ExternalLink, Loader2, Plug } from "lucide-react";
import { PROVIDERS, parseSourceLink } from "@stremlist/shared/providers";
import type { ProviderId, SourceKind } from "@stremlist/shared/providers";
import type { DisplayMode } from "@stremlist/shared/constants";
import { api } from "@/lib/api";
import { detectedLinkHint } from "@/lib/list-sources";
import { cn } from "@/lib/utils";

export interface ResolvedLink {
  provider: ProviderId;
  sourceRef: string;
  kind: SourceKind;
  suggestedTitle: string | null;
  defaultDisplayMode: DisplayMode | null;
}

type LinkProblem = {
  message: string;
  /** "info" for expected states (coming soon), red otherwise. */
  tone?: "info";
  steps?: string[];
  link?: { href: string; label: string };
  provider?: ProviderId;
  action?: "connect" | "upgrade";
};

const SUPPORTED_LABELS = "IMDb, Trakt, MDBList, JustWatch or SensCritique";

function privateMessage(provider: ProviderId): string {
  switch (provider) {
    case "imdb":
      return "This IMDb list is private. Make it public in your IMDb account settings, then try again.";
    case "trakt":
      return "This Trakt list is private. Set its privacy to Public on Trakt, or connect Trakt to add your own private lists.";
    case "justwatch":
      return "This JustWatch list is not shared. In JustWatch, open the list, choose Share to get its link, then paste that link here.";
    case "senscritique":
      return "This SensCritique list is private. Make it public on SensCritique, then try again.";
    default:
      return `This ${PROVIDERS[provider].label} list is private. Make it public, then try again.`;
  }
}

/** Turn a `/links/resolve` refusal into a message and a next step. */
function describeLinkProblem(
  reason: string,
  provider: ProviderId | undefined,
  access: "new" | "private" | "legacy",
): LinkProblem {
  const label = provider ? PROVIDERS[provider].label : "This site";
  switch (reason) {
    case "unrecognized":
      return {
        message: `We do not recognize this link. Paste a link to a watchlist or list on ${SUPPORTED_LABELS}.`,
      };
    case "coming_soon":
      return {
        provider,
        tone: "info",
        message:
          provider === "letterboxd"
            ? "Letterboxd is coming soon. Tip: import it into MDBList, then add the MDBList list."
            : `${label} is coming soon.`,
        steps:
          provider === "letterboxd"
            ? [
                "Sign in to MDBList and open My Lists, External tab.",
                'Paste the Letterboxd list or watchlist link in "List URL", then click Parse.',
                "Connect MDBList here and add that external list. Free MDBList accounts get 1 external list.",
              ]
            : undefined,
        link:
          provider === "letterboxd"
            ? {
                href: "https://mdblist.com/mylists/#external_lists",
                label: "Open MDBList external lists",
              }
            : undefined,
      };
    case "disabled":
      return {
        provider,
        message: `${label} is temporarily unavailable. Please try again later.`,
      };
    case "needs_connection":
      return access === "legacy"
        ? {
            provider,
            action: "upgrade",
            message: `This list needs your ${label} account. Connections need a private Addon URL, so upgrade this install first.`,
          }
        : {
            provider,
            action: "connect",
            message:
              access === "new"
                ? `This list needs your ${label} account. Connect ${label} to add it. Stremlist saves your setup first to create your private Addon URL.`
                : `This list needs your ${label} account. Connect ${label} to add it.`,
          };
    case "private":
      return { provider, message: provider ? privateMessage(provider) : "" };
    case "not_found":
      return {
        provider,
        message: `${label} could not find this list. Check the link and try again.`,
      };
    case "premium_only":
      return {
        provider,
        message: `This list needs a paid ${label} plan to be read.`,
      };
    default:
      return {
        provider,
        message: `${label} did not answer. Please try again in a moment.`,
      };
  }
}

/**
 * The paste-a-link field. The Provider is detected while typing (no network),
 * then `POST /links/resolve` confirms the Source list when the user adds it.
 */
export default function LinkPaste({
  accountKey,
  access,
  disabled,
  disabledReason,
  initialValue,
  onInitialValueUsed,
  onDetect,
  onResolved,
  onConnect,
  onUpgrade,
}: {
  accountKey: string | null;
  access: "new" | "private" | "legacy";
  disabled?: boolean;
  disabledReason?: string;
  /** Pre-filled link (from Home, or kept across an OAuth round trip). */
  initialValue?: string;
  /** Called once the initial link was submitted, so it is not added twice. */
  onInitialValueUsed?: () => void;
  onDetect: (provider: ProviderId | null) => void;
  /** Add the List. Returns an error message when it cannot be added. */
  onResolved: (link: ResolvedLink) => string | null;
  onConnect: (provider: ProviderId, pendingLink: string) => void;
  onUpgrade: () => void;
}) {
  const inputId = useId();
  const [value, setValue] = useState(initialValue ?? "");
  const [resolving, setResolving] = useState(false);
  const [problem, setProblem] = useState<LinkProblem | null>(null);
  const autoSubmitted = useRef(false);

  const detected = parseSourceLink(value);
  const detectedProvider = detected?.provider ?? null;

  useEffect(() => {
    onDetect(detectedProvider);
  }, [detectedProvider, onDetect]);

  const submit = async (input = value) => {
    const trimmed = input.trim();
    if (!trimmed || resolving || disabled) return;
    setProblem(null);

    // Answer the obvious cases without a round trip.
    const parsed = parseSourceLink(trimmed);
    if (!parsed) {
      setProblem(describeLinkProblem("unrecognized", undefined, access));
      return;
    }
    if (PROVIDERS[parsed.provider].availability !== "available") {
      setProblem(describeLinkProblem("coming_soon", parsed.provider, access));
      return;
    }

    setResolving(true);
    try {
      const res = await api.links.resolve.$post({
        json: { input: trimmed, accountKey: accountKey ?? undefined },
      });
      if (!res.ok) throw new Error("resolve failed");
      const body = await res.json();
      if (!body.ok) {
        setProblem(
          describeLinkProblem(
            body.reason,
            "provider" in body ? body.provider : undefined,
            access,
          ),
        );
        return;
      }
      const error = onResolved({
        provider: body.provider,
        sourceRef: body.sourceRef,
        kind: body.kind,
        suggestedTitle: body.suggestedTitle,
        defaultDisplayMode: body.defaultDisplayMode,
      });
      if (error) {
        setProblem({ message: error });
      } else {
        setValue("");
      }
    } catch {
      setProblem({
        message: "Could not check this link. Please try again in a moment.",
      });
    } finally {
      setResolving(false);
    }
  };

  // A link carried over from Home or an OAuth round trip is added at once.
  useEffect(() => {
    if (!initialValue || autoSubmitted.current) return;
    autoSubmitted.current = true;
    onInitialValueUsed?.();
    void submit(initialValue);
    // Run once for the initial link only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialValue]);

  const hint = (() => {
    if (!value.trim()) return null;
    if (!detected) return "No supported site recognized yet.";
    return detectedLinkHint(detected);
  })();

  return (
    <div>
      <label htmlFor={inputId} className="sr-only">
        Paste a link to a watchlist or list
      </label>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className={cn(
          "flex items-center gap-2 rounded-2xl bg-white/10 p-1.5 ring-1 ring-transparent transition-shadow focus-within:ring-brand/60",
          disabled && "opacity-60",
        )}
      >
        <input
          id={inputId}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setProblem(null);
          }}
          disabled={disabled}
          placeholder="Paste a link to any list"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent px-3 py-2.5 text-cloud outline-none placeholder:text-white/40"
        />
        <button
          type="submit"
          disabled={disabled || resolving || !value.trim()}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-brand px-4 py-2.5 text-sm font-bold text-black transition-[opacity,scale] duration-150 active:scale-[0.97] disabled:opacity-30"
        >
          {resolving && <Loader2 className="size-4 animate-spin" />}
          {resolving ? "Checking" : "Add"}
        </button>
      </form>
      <p
        aria-live="polite"
        className={cn(
          "mt-2 min-h-5 px-1 text-xs",
          detected && !problem ? "text-brand" : "text-white/45",
        )}
      >
        {disabled && disabledReason
          ? disabledReason
          : (hint ??
            "IMDb, Trakt, MDBList, JustWatch and SensCritique links work.")}
      </p>
      {problem && problem.message && (
        <div
          role="alert"
          className={cn(
            "mt-2 rounded-2xl px-4 py-3 text-sm ring-1",
            problem.tone === "info"
              ? "bg-white/10 text-cloud ring-white/15"
              : "bg-red-500/15 text-red-100 ring-red-400/30",
          )}
        >
          <p>{problem.message}</p>
          {problem.steps && (
            <ol className="mt-2 list-decimal space-y-1 pl-5 opacity-85">
              {problem.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          )}
          {problem.link && (
            <a
              href={problem.link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center gap-1 font-semibold text-brand hover:underline"
            >
              {problem.link.label}
              <ExternalLink className="size-3.5" />
            </a>
          )}
          {problem.action === "connect" && problem.provider && (
            <button
              type="button"
              onClick={() => onConnect(problem.provider!, value.trim())}
              className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-brand px-3 py-1.5 text-xs font-bold text-black"
            >
              <Plug className="size-3.5" />
              Connect {PROVIDERS[problem.provider].label}
            </button>
          )}
          {problem.action === "upgrade" && (
            <button
              type="button"
              onClick={onUpgrade}
              className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 text-xs font-bold text-cloud"
            >
              Upgrade to a private URL
            </button>
          )}
        </div>
      )}
    </div>
  );
}
