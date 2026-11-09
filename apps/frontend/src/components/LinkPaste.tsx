import { useEffect, useId, useRef, useState } from "react";
import type { InferResponseType } from "hono/client";
import { toast } from "sonner";
import { Loader2, Plug } from "lucide-react";
import {
  joinProviderLabels,
  LINK_PROVIDERS,
  PROVIDERS,
  parseSourceLink,
} from "@stremlist/shared/providers";
import type { ProviderId } from "@stremlist/shared/providers";
import { SOURCE_LINK_MAX_LENGTH } from "@stremlist/shared/constants";
import type { DisplayMode } from "@stremlist/shared/constants";
import {
  sourceNoun,
  sourceProblemCopy,
} from "@stremlist/shared/source-problems";
import type {
  SourceNoun,
  SourceProblemReason,
} from "@stremlist/shared/source-problems";
import { useNow } from "@/hooks/useNow";
import type { AccountAccess } from "@/lib/account-config";
import { api } from "@/lib/api";
import {
  detectedLinkHint,
  extractAccountKey,
  PASTE_LINK_PROMPT,
} from "@/lib/list-sources";
import { queueLabel, queueWait, retryDelay } from "@/lib/provider-queue";
import type { QueueWait } from "@/lib/provider-queue";
import { cn } from "@/lib/utils";

export interface ResolvedLink {
  provider: ProviderId;
  sourceRef: string;
  suggestedTitle: string | null;
  defaultDisplayMode: DisplayMode | null;
}

type LinkProblem = {
  message: string;
  /** "info" for expected states (coming soon), red otherwise. */
  tone?: "info";
  provider?: ProviderId;
  action?: "connect" | "upgrade";
  /** The Account key of another install, to open its configure page. */
  openAccount?: string;
};

/** The answer to a pasted Addon URL: it is an install, not a list. */
function addonUrlProblem(key: string, accountKey: string | null): LinkProblem {
  const fix = `It is not a list. ${PASTE_LINK_PROMPT}.`;
  return key === accountKey
    ? { message: `This is the Addon URL of this Stremlist. ${fix}` }
    : {
        message: `This is the Addon URL of a different Stremlist. ${fix}`,
        openAccount: key,
      };
}

type LinkProblemReason = SourceProblemReason | "unrecognized" | "too_long";

type ResolveAnswer = InferResponseType<typeof api.links.resolve.$post>;

/** Turn a `/links/resolve` refusal into a message and a next step. */
function describeLinkProblem(
  reason: LinkProblemReason,
  provider: ProviderId | undefined,
  access: AccountAccess,
  source: { noun: SourceNoun; sourceRef?: string },
): LinkProblem {
  if (reason === "too_long") {
    return {
      message: `This link is too long. Paste a link of at most ${SOURCE_LINK_MAX_LENGTH} characters.`,
    };
  }
  if (reason === "unrecognized" || !provider) {
    return {
      message: `We do not recognize this link. ${PASTE_LINK_PROMPT} on ${joinProviderLabels(LINK_PROVIDERS, "or")}.`,
    };
  }
  const label = PROVIDERS[provider].label;
  const { title, fix } = sourceProblemCopy(
    provider,
    reason,
    source.noun,
    source.sourceRef,
  );
  switch (reason) {
    case "coming_soon":
      return { provider, tone: "info", message: `${title}. ${fix}` };
    case "needs_connection":
      // On this page the fix is a button, not a sentence.
      return access === "legacy"
        ? {
            provider,
            action: "upgrade",
            message: `${title}. Connections need a private Addon URL, so upgrade this install first.`,
          }
        : {
            provider,
            action: "connect",
            message:
              access === "new"
                ? `${title}. Connect ${label} to add it. Stremlist saves your setup first to create your private Addon URL.`
                : `${title}. Connect ${label} to add it.`,
          };
    default:
      return { provider, message: `${title}. ${fix}` };
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
  access: AccountAccess;
  disabled: boolean;
  disabledReason: string;
  /** Pre-filled link (from Home, or kept across an OAuth round trip). */
  initialValue?: string;
  /** Called once the initial link was submitted, so it is not added twice. */
  onInitialValueUsed: () => void;
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
  // Set while the check waits in the Provider's queue (Letterboxd).
  const [queue, setQueue] = useState<QueueWait | null>(null);
  const autoSubmitted = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

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
    if (trimmed.length > SOURCE_LINK_MAX_LENGTH) {
      setProblem(
        describeLinkProblem("too_long", undefined, access, { noun: "list" }),
      );
      return;
    }
    const parsed = parseSourceLink(trimmed);
    const pastedAccount = parsed ? null : extractAccountKey(trimmed);
    if (pastedAccount) {
      setProblem(addonUrlProblem(pastedAccount, accountKey));
      return;
    }
    if (!parsed) {
      setProblem(
        describeLinkProblem("unrecognized", undefined, access, {
          noun: "list",
        }),
      );
      return;
    }
    const source = {
      noun: sourceNoun(parsed.kind),
      sourceRef: parsed.sourceRef,
    };
    if (PROVIDERS[parsed.provider].availability !== "available") {
      setProblem(
        describeLinkProblem("coming_soon", parsed.provider, access, source),
      );
      return;
    }

    setResolving(true);
    try {
      let ticket: string | undefined;
      let wait: QueueWait | null = null;
      let body: ResolveAnswer;
      // A queued answer keeps the place in the queue: ask again with its
      // ticket when the queue says so.
      for (;;) {
        const res = await api.links.resolve.$post({
          json: { input: trimmed, accountKey: accountKey ?? undefined, ticket },
        });
        if (!res.ok) throw new Error("resolve failed");
        body = await res.json();
        if (body.ok || body.reason !== "queued") break;
        wait = queueWait(body, Date.now(), wait);
        setQueue(wait);
        ticket = body.ticket ?? undefined;
        const delay = retryDelay(body.retryMs);
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (!mounted.current) return;
      }
      setQueue(null);
      if (!body.ok) {
        setProblem(
          describeLinkProblem(
            body.reason,
            "provider" in body ? body.provider : undefined,
            access,
            source,
          ),
        );
        return;
      }
      const error = onResolved({
        provider: body.provider,
        sourceRef: body.sourceRef,
        suggestedTitle: body.suggestedTitle,
        defaultDisplayMode: body.defaultDisplayMode,
      });
      if (error) setProblem({ message: error });
      else setValue("");
    } catch {
      toast.error("Could not check this link. Please try again in a moment.");
    } finally {
      setQueue(null);
      setResolving(false);
    }
  };

  // A link carried over from Home or an OAuth round trip is added at once.
  useEffect(() => {
    if (!initialValue || autoSubmitted.current) return;
    autoSubmitted.current = true;
    onInitialValueUsed();
    void submit(initialValue);
    // Run once for the initial link only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialValue]);

  const hint = (() => {
    if (!value.trim()) return null;
    if (!detected && extractAccountKey(value)) {
      return "Stremlist Addon URL detected. This is not a list.";
    }
    if (!detected) return "No supported site recognized yet.";
    return detectedLinkHint(detected);
  })();

  return (
    <div>
      <label htmlFor={inputId} className="sr-only">
        {PASTE_LINK_PROMPT}
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
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-brand px-4 py-2.5 text-sm font-bold text-black transition-[opacity,scale] duration-150 active:scale-[0.97]",
            // A check in progress stays readable: it can show the queue state.
            resolving ? "disabled:opacity-80" : "disabled:opacity-30",
          )}
        >
          {resolving && <Loader2 className="size-4 animate-spin" />}
          {resolving ? <CheckingLabel queue={queue} /> : "Add"}
        </button>
      </form>
      <p
        aria-live="polite"
        className={cn(
          "mt-2 min-h-5 px-1 text-xs",
          detected && !problem ? "text-brand" : "text-white/45",
        )}
      >
        {disabled
          ? disabledReason
          : (hint ?? `${joinProviderLabels(LINK_PROVIDERS)} links work.`)}
      </p>
      {problem && (
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
          {problem.openAccount && (
            <a
              href={`/configure?account=${encodeURIComponent(problem.openAccount)}`}
              className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 text-xs font-bold text-cloud"
            >
              Open that Stremlist
            </a>
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

/** "Checking", or the queue state while the check waits its turn. */
function CheckingLabel({ queue }: { queue: QueueWait | null }) {
  const now = useNow();
  return (
    <span className="tabular-nums">{queueLabel(queue, now) ?? "Checking"}</span>
  );
}
