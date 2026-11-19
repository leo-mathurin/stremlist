import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import type { Ref } from "react";
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
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export interface ResolvedLink {
  provider: ProviderId;
  sourceRef: string;
  suggestedTitle: string | null;
  defaultDisplayMode: DisplayMode | null;
}

export type LinkProblem = {
  message: string;
  /** "info" for expected states (coming soon), red otherwise. */
  tone?: "info";
  provider?: ProviderId;
  action?: "connect" | "upgrade";
  /** The Account key of another install, to open its configure page. */
  openAccount?: string;
  showList?: () => void;
};

function addonUrlProblem(key: string, accountKey: string | null) {
  const fix = `It is not a list. ${PASTE_LINK_PROMPT}.`;
  return key === accountKey
    ? ({
        message: `This is the Addon URL of this Stremlist. ${fix}`,
      } satisfies LinkProblem)
    : ({
        message: `This is the Addon URL of a different Stremlist. ${fix}`,
        openAccount: key,
      } satisfies LinkProblem);
}

type LinkProblemReason = SourceProblemReason | "unrecognized" | "too_long";

type ResolveAnswer = InferResponseType<typeof api.links.resolve.$post, 200>;

type SettledAnswer = Exclude<ResolveAnswer, { reason: "queued" }>;

function describeLinkProblem(
  reason: LinkProblemReason,
  provider: ProviderId | undefined,
  access: AccountAccess,
  source: { noun: SourceNoun; sourceRef?: string },
) {
  if (reason === "too_long") {
    return {
      message: `This link is too long. Paste a link of at most ${SOURCE_LINK_MAX_LENGTH} characters.`,
    } satisfies LinkProblem;
  }
  if (reason === "unrecognized" || !provider) {
    return {
      message: `We do not recognize this link. ${PASTE_LINK_PROMPT} on ${joinProviderLabels(LINK_PROVIDERS, "or")}.`,
    } satisfies LinkProblem;
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
      return {
        provider,
        tone: "info",
        message: `${title}. ${fix}`,
      } satisfies LinkProblem;
    case "needs_connection":
      return access === "legacy"
        ? ({
            provider,
            action: "upgrade",
            message: `${title}. To connect an account, you need a private Addon URL. Upgrade this install first.`,
          } satisfies LinkProblem)
        : ({
            provider,
            action: "connect",
            message:
              access === "new"
                ? `${title}. Connect ${label} to add it. When it connects, Stremlist saves your setup and gives you a private Addon URL.`
                : `${title}. Connect ${label} to add it.`,
          } satisfies LinkProblem);
    case "private":
    case "not_found":
    case "disabled":
    case "premium_only":
    case "unavailable":
      return { provider, message: `${title}. ${fix}` } satisfies LinkProblem;
  }
  return { provider, message: `${title}. ${fix}` } satisfies LinkProblem;
}

async function resolveLink(
  input: string,
  accountKey: string | null,
  onQueue: (wait: QueueWait) => void,
  isMounted: () => boolean,
) {
  let ticket: string | undefined;
  let wait: QueueWait | null = null;
  try {
    for (;;) {
      const res = await api.links.resolve.$post({
        json: { input, accountKey: accountKey ?? undefined, ticket },
      });
      if (!res.ok) return "failed";
      const body = await res.json();
      if (body.ok || body.reason !== "queued") {
        const settled: SettledAnswer = body;
        return settled;
      }
      wait = queueWait(body, Date.now(), wait);
      onQueue(wait);
      ticket = body.ticket ?? undefined;
      const delay = retryDelay(body.retryMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (!isMounted()) return "gone";
    }
  } catch {
    return "failed";
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
  inputRef,
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
  /** Add the List, or return feedback to show beside the field. */
  onResolved: (link: ResolvedLink) => LinkProblem | null;
  onConnect: (provider: ProviderId, pendingLink: string) => void;
  onUpgrade: () => void;
  /** The paste field, so another control can focus it. */
  inputRef?: Ref<HTMLInputElement>;
}) {
  const inputId = useId();
  const [value, setValue] = useState(initialValue ?? "");
  const [resolving, setResolving] = useState(false);
  const [problem, setProblem] = useState<LinkProblem | null>(null);
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
    const body = await resolveLink(
      trimmed,
      accountKey,
      setQueue,
      () => mounted.current,
    );
    if (body === "gone") return;
    setQueue(null);
    setResolving(false);
    if (body === "failed") {
      toast.error("Could not check this link. Please try again in a moment.");
      return;
    }
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
    const resolvedProblem = onResolved({
      provider: body.provider,
      sourceRef: body.sourceRef,
      suggestedTitle: body.suggestedTitle,
      defaultDisplayMode: body.defaultDisplayMode,
    });
    if (resolvedProblem) setProblem(resolvedProblem);
    else setValue("");
  };

  const submitInitial = useEffectEvent((link: string) => {
    onInitialValueUsed();
    void submit(link);
  });
  useEffect(() => {
    if (!initialValue || autoSubmitted.current) return;
    autoSubmitted.current = true;
    submitInitial(initialValue);
  }, [initialValue]);

  const connectProvider =
    problem?.action === "connect" ? problem.provider : undefined;

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
          ref={inputRef}
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
        <Alert
          role={problem.tone === "info" ? "status" : "alert"}
          variant={problem.tone === "info" ? "dark" : "destructive-dark"}
          className="mt-2"
        >
          <p>{problem.message}</p>
          {problem.showList && (
            <Button
              type="button"
              variant="soft-dark"
              size="pill-xs"
              onClick={problem.showList}
              className="mt-2"
            >
              Show
            </Button>
          )}
          {connectProvider && (
            <Button
              type="button"
              size="pill-xs"
              onClick={() => onConnect(connectProvider, value.trim())}
              className="mt-2"
            >
              <Plug className="size-3.5" />
              Connect {PROVIDERS[connectProvider].label}
            </Button>
          )}
          {problem.openAccount && (
            <Button variant="soft-dark" size="pill-xs" asChild className="mt-2">
              <a
                href={`/configure?account=${encodeURIComponent(problem.openAccount)}`}
              >
                Open that Stremlist
              </a>
            </Button>
          )}
          {problem.action === "upgrade" && (
            <Button
              type="button"
              variant="soft-dark"
              size="pill-xs"
              onClick={onUpgrade}
              className="mt-2"
            >
              Upgrade to a private URL
            </Button>
          )}
        </Alert>
      )}
    </div>
  );
}

function CheckingLabel({ queue }: { queue: QueueWait | null }) {
  const now = useNow();
  return (
    <span className="tabular-nums">{queueLabel(queue, now) ?? "Checking"}</span>
  );
}
