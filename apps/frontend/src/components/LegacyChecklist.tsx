import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import {
  ArrowRight,
  Check,
  ChevronDown,
  KeyRound,
  Loader2,
  Sparkles,
  X,
} from "lucide-react";
import {
  joinProviderLabels,
  LINK_PROVIDERS,
  PROVIDERS,
} from "@stremlist/shared/providers";
import type { ProviderId } from "@stremlist/shared/providers";
import AddonInstallActions from "./AddonInstallActions";
import { ProviderMark } from "./brand";
import { CONNECTABLE_PROVIDERS } from "@/lib/provider-groups";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

const PUBLIC_PROVIDERS = LINK_PROVIDERS.filter(
  (id) => id !== "imdb" && PROVIDERS[id].connection !== "required",
);

type StepId = "works" | "public" | "private";

const PRIMARY_LAYOUT = "h-11 w-full sm:w-auto";

export interface LegacyChecklistProps {
  /** The Legacy alias (IMDb ID) of this install. */
  legacyKey: string;
  /** The user opened this install from Home, with "Open my Stremlist". */
  fromHome: boolean;
  /** IMDb Lists of the setup. */
  imdbLists: number;
  /** The setup has a List from another Provider. */
  otherProviderAdded: boolean;
  /** The setup has edits that are not saved. */
  unsaved: boolean;
  /** This page cannot change the setup any more (after the upgrade). */
  locked: boolean;
  /** The private Account that the upgrade made, if any. */
  upgradedTo: string | null;
  /** The user confirmed that the new install is done. */
  upgradeConfirmed: boolean;
  onUpgrade: () => Promise<string | null>;
  onConfirmUpgrade: () => void;
  /** Called before the link opens the configure page of `accountId`. */
  onOpenNew: (accountId: string) => void;
  /** Bring the paste field into view and focus it. */
  onPasteLink: () => void;
  onHide: () => void;
  /** Increments when another control asks for the upgrade. */
  upgradeRequest: number;
}

/**
 * What v2 means for a v1 install, as a short checklist: the install still
 * works, other sites' public lists work on it, and an optional private Addon
 * URL that the whole upgrade happens in.
 */
export default function LegacyChecklist({
  legacyKey,
  fromHome,
  imdbLists,
  otherProviderAdded,
  unsaved,
  locked,
  upgradedTo,
  upgradeConfirmed,
  onUpgrade,
  onConfirmUpgrade,
  onOpenNew,
  onPasteLink,
  onHide,
  upgradeRequest,
}: LegacyChecklistProps) {
  const [open, setOpen] = useState<StepId | null>(() =>
    upgradeRequest > 0 || otherProviderAdded || upgradedTo
      ? "private"
      : "public",
  );
  const card = useRef<HTMLElement>(null);

  const [seen, setSeen] = useState({
    request: upgradeRequest,
    other: otherProviderAdded,
  });
  if (seen.request !== upgradeRequest || seen.other !== otherProviderAdded) {
    if (
      (upgradeRequest > 0 && upgradeRequest !== seen.request) ||
      (otherProviderAdded && !seen.other)
    ) {
      setOpen("private");
    }
    setSeen({ request: upgradeRequest, other: otherProviderAdded });
  }
  useEffect(() => {
    if (upgradeRequest === 0) return;
    card.current?.scrollIntoView({
      behavior: scrollBehavior(),
      block: "start",
    });
  }, [upgradeRequest]);

  const done: Record<StepId, boolean> = {
    works: true,
    public: otherProviderAdded,
    private: !!upgradedTo && upgradeConfirmed,
  };
  const doneCount = Object.values(done).filter(Boolean).length;
  const toggle = (id: StepId) => setOpen(open === id ? null : id);

  return (
    <section
      ref={card}
      id="upgrade"
      aria-labelledby="legacy-checklist-title"
      className="checklist-rise scroll-mt-6 rounded-3xl bg-white ring-1 ring-black/5"
    >
      <header className="flex items-start gap-4 p-5 pb-3">
        <ProgressRing done={doneCount} total={3} />
        <div className="min-w-0 flex-1">
          <h3
            id="legacy-checklist-title"
            className="text-lg leading-snug font-bold text-balance"
          >
            {fromHome
              ? "Found your install. It still works."
              : "Stremlist 2.0 is here. Your install still works."}
          </h3>
          <p className="mt-0.5 text-sm text-pretty text-black/55">
            Your IMDb lists keep syncing. The rest is optional.
          </p>
        </div>
        <Button
          type="button"
          variant="quiet"
          size="icon-round-lg"
          onClick={onHide}
          aria-label="Hide what's new"
          className="-mt-1 -mr-2"
        >
          <X className="size-4" />
        </Button>
      </header>

      <ol className="checklist-stagger px-2 pb-2">
        <Step
          index={0}
          title={worksTitle(imdbLists)}
          done={done.works}
          open={open === "works"}
          onToggle={() => toggle("works")}
        >
          <p className="text-sm text-pretty text-black/60">
            Nothing to do. The install with your IMDb user ID{" "}
            <span className="font-mono text-ink">{legacyKey}</span> keeps
            working in Stremio, with the same catalogs.
          </p>
        </Step>
        <Step
          index={1}
          title="Add a list from another site"
          done={done.public}
          open={open === "public"}
          onToggle={() => toggle("public")}
          trailing={<ProviderStack providers={PUBLIC_PROVIDERS} />}
        >
          <p className="text-sm text-pretty text-black/60">
            {`Paste a public link from ${joinProviderLabels(PUBLIC_PROVIDERS, "or")}. It works on this install. Save, then reinstall in Stremio.`}
          </p>
          {otherProviderAdded ? (
            <p className="checklist-rise mt-3 text-sm font-semibold text-success-700">
              {unsaved
                ? "List added. Save, then reinstall to see it."
                : "You have a list from another site."}
            </p>
          ) : (
            !locked && (
              <Button
                type="button"
                variant="dark"
                size="pill"
                onClick={onPasteLink}
                className="mt-3"
              >
                Paste a link
              </Button>
            )
          )}
        </Step>
        <Step
          index={2}
          title="Get a private Addon URL"
          badge="Optional"
          done={done.private}
          open={open === "private"}
          onToggle={() => toggle("private")}
          trailing={<ProviderStack providers={CONNECTABLE_PROVIDERS} />}
        >
          <p className="mb-4 text-sm text-pretty text-black/60">
            {`Connect ${joinProviderLabels(CONNECTABLE_PROVIDERS, "or")}, and rate or mark as watched from Stremio. Your lists come with you.`}
          </p>
          <UpgradeStep
            upgradedTo={upgradedTo}
            confirmed={upgradeConfirmed}
            onUpgrade={onUpgrade}
            onConfirm={onConfirmUpgrade}
            onOpenNew={onOpenNew}
          />
        </Step>
      </ol>

      <footer className="flex items-center justify-between gap-3 border-t border-black/5 px-5 py-3 text-xs text-black/45">
        <span className="tabular-nums">{doneCount} of 3 done</span>
        <Link
          to="/changelog#v2-0-0"
          className="font-semibold transition-colors hover:text-stremlist"
        >
          See everything new in 2.0
        </Link>
      </footer>
    </section>
  );
}

/** The button on the "Refreshed" line that opens the closed card again. */
export function WhatsNewButton({ onClick }: { onClick: () => void }) {
  return (
    <span className="checklist-fade-in inline-flex shrink-0">
      <Button type="button" variant="plain" size="pill" onClick={onClick}>
        <Sparkles className="size-4 text-brand-dark" />
        <span>
          What's new<span className="hidden sm:inline"> in 2.0</span>
        </span>
      </Button>
    </span>
  );
}

function worksTitle(imdbLists: number) {
  if (imdbLists === 0) return "Your install still works";
  if (imdbLists === 1) return "Your IMDb list still syncs";
  return `Your ${imdbLists} IMDb lists still sync`;
}

function UpgradeStep({
  upgradedTo,
  confirmed,
  onUpgrade,
  onConfirm,
  onOpenNew,
}: {
  upgradedTo: string | null;
  confirmed: boolean;
  onUpgrade: () => Promise<string | null>;
  onConfirm: () => void;
  onOpenNew: (accountId: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  if (!upgradedTo) {
    const create = async () => {
      setBusy(true);
      await onUpgrade();
      setBusy(false);
    };
    return (
      <Button
        type="button"
        size="pill-lg"
        onClick={() => void create()}
        disabled={busy}
        className={PRIMARY_LAYOUT}
      >
        {busy && <Loader2 className="size-4 animate-spin" />}
        {busy ? "Creating your URL" : "Create my private Addon URL"}
      </Button>
    );
  }

  if (confirmed) {
    return (
      <div className="checklist-rise space-y-3">
        <p className="flex items-center gap-2 text-sm font-semibold text-success-700">
          <Check className="checklist-check size-4 shrink-0" />
          All set. Open Stremlist from the new install from now on.
        </p>
        <Button
          variant="dark"
          size="pill-lg"
          asChild
          className={PRIMARY_LAYOUT}
        >
          <Link
            to={`/configure?account=${encodeURIComponent(upgradedTo)}`}
            onClick={() => onOpenNew(upgradedTo)}
          >
            Open my new configure page
            <ArrowRight className="size-4" />
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="checklist-rise space-y-3 text-sm">
      <p className="font-semibold text-pretty">Install your new URL:</p>
      <AddonInstallActions accountKey={upgradedTo} />
      <p className="flex items-center gap-2 text-xs text-pretty text-black/55">
        <KeyRound className="size-3.5 shrink-0" />
        Keep it secret. Then remove the old Stremlist from Stremio.
      </p>
      <Button
        type="button"
        variant="dark"
        size="pill-lg"
        onClick={onConfirm}
        className={PRIMARY_LAYOUT}
      >
        Done
      </Button>
    </div>
  );
}

function Step({
  index,
  title,
  badge,
  done,
  open,
  onToggle,
  trailing,
  children,
}: {
  index: number;
  title: string;
  badge?: string;
  done: boolean;
  open: boolean;
  onToggle: () => void;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <li style={{ "--i": index }}>
      <Collapsible open={open} onOpenChange={onToggle} asChild>
        <div
          className={cn(
            "rounded-2xl transition-colors duration-150",
            open && "bg-black/[0.03]",
          )}
        >
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition-colors duration-150 hover:bg-black/[0.03]"
            >
              <CheckDot done={done} />
              <span
                className={cn(
                  "min-w-0 flex-1 font-semibold text-pretty",
                  done && !open && "text-black/45",
                )}
              >
                {title}
                {done && <span className="sr-only"> (completed)</span>}
                {badge && (
                  <span className="ml-2 inline-block rounded-full bg-black/5 px-2 py-0.5 align-[1px] text-2xs font-semibold text-black/50">
                    {badge}
                  </span>
                )}
              </span>
              {trailing && <span className="hidden sm:block">{trailing}</span>}
              <ChevronDown
                className={cn(
                  "size-4 shrink-0 text-black/40 transition-transform duration-200 ease-out-quint motion-reduce:transition-none",
                  open && "rotate-180",
                )}
              />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="px-3 pb-4 pl-12">{children}</div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    </li>
  );
}

function ProviderStack({ providers }: { providers: readonly ProviderId[] }) {
  return (
    <span className="flex items-center">
      {providers.map((provider, index) => (
        <ProviderMark
          key={provider}
          provider={provider}
          className={cn("size-6 ring-2 ring-white", index > 0 && "-ml-2")}
        />
      ))}
    </span>
  );
}

function CheckDot({ done }: { done: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-full ring-1 transition-colors duration-200",
        done
          ? "bg-success-500 text-white ring-success-500"
          : "bg-white ring-black/15",
      )}
    >
      {done && <Check className="checklist-check size-3.5" strokeWidth={3} />}
    </span>
  );
}

function ProgressRing({ done, total }: { done: number; total: number }) {
  const r = 17;
  const c = 2 * Math.PI * r;
  return (
    <span
      aria-hidden="true"
      className="relative flex size-10 shrink-0 items-center justify-center"
    >
      <svg viewBox="0 0 40 40" className="absolute inset-0 -rotate-90">
        <circle
          cx="20"
          cy="20"
          r={r}
          fill="none"
          strokeWidth="3"
          className="stroke-black/10"
        />
        <circle
          cx="20"
          cy="20"
          r={r}
          fill="none"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - done / total)}
          className="stroke-success-500 transition-[stroke-dashoffset] duration-250 ease-out-quint motion-reduce:transition-none"
        />
      </svg>
      <span className="text-xs font-bold tabular-nums">
        {done}/{total}
      </span>
    </span>
  );
}

function scrollBehavior() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}
