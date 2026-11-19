import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useId, useState } from "react";
import {
  Check,
  ChevronDown,
  Download,
  Loader2,
  MonitorPlay,
  RefreshCw,
  Zap,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RELOAD_HINT } from "@/hooks/useStremioSync";
import type { StremioSync } from "@/hooks/useStremioSync";
import { reinstallLinkProps } from "@/lib/list-sources";
import type { ReinstallState } from "@/lib/reinstall";
import { cn } from "@/lib/utils";

/**
 * A block that appears in the page: a short rise with a strong ease-out.
 * Reduced motion keeps the fade only.
 */
export const ENTER =
  "transition-[opacity,translate] duration-200 ease-out-quint starting:translate-y-1.5 starting:opacity-0 motion-reduce:starting:translate-y-0";

function maskEmail(email: string) {
  const [name, domain] = email.split("@");
  return domain ? `${name.slice(0, 2)}•••@${domain}` : email;
}

/**
 * How a save reaches Stremio. Stremio reads catalogs and Actions only when it
 * installs an addon, so a change needs either a reinstall or an update of the
 * installed addon through a linked Stremio account. The member chooses; the
 * reinstall stays available in every state.
 */
export function StremioUpdateNotice({
  accountKey,
  state,
  stremio,
  onReinstalled,
}: {
  accountKey: string;
  state: ReinstallState;
  stremio: StremioSync;
  onReinstalled: () => void;
}) {
  const reinstalled = () => {
    onReinstalled();
    stremio.clearStatus();
  };

  if (stremio.link.kind !== "idle") return <LinkCard stremio={stremio} />;

  if (stremio.sync.kind === "failed") {
    return (
      <FailureCard
        accountKey={accountKey}
        stremio={stremio}
        onReinstalled={reinstalled}
      />
    );
  }

  if (stremio.connection) {
    if (state === "after-save") {
      return (
        <p className={cn("text-sm text-black/55", ENTER)}>
          Stremio will update when you save.
        </p>
      );
    }
    if (state === "required" && stremio.sync.kind === "idle") {
      return (
        <OutdatedCard
          accountKey={accountKey}
          stremio={stremio}
          onReinstalled={reinstalled}
        />
      );
    }
    return null;
  }

  if (state === "required") {
    return (
      <ChoiceCard
        accountKey={accountKey}
        stremio={stremio}
        onReinstalled={reinstalled}
      />
    );
  }

  if (state === "after-save") {
    return (
      <p
        className={cn(
          "flex gap-2.5 rounded-2xl bg-warning-50 px-4 py-3 text-sm text-pretty text-warning-900 ring-1 ring-warning-200",
          ENTER,
        )}
      >
        <RefreshCw className="mt-0.5 size-4 shrink-0" />
        <span>
          <strong className="font-semibold">
            These changes need a reinstall.
          </strong>{" "}
          Stremio reads catalogs and Actions only when you install the addon.{" "}
          {stremio.available
            ? "After you save, Stremlist can update it for you, or you can reinstall Stremlist."
            : "After you save, reinstall Stremlist."}
        </span>
      </p>
    );
  }

  return null;
}

/**
 * The linked account and the last update, at the end of the "Refreshed"
 * line. On phones it wraps under that line, so it aligns left. The reload
 * hint is in a toast when the update ends (useStremioSync), and stays in the
 * menu. Failures are cards of their own, under that line.
 */
export function StremioStatus({ stremio }: { stremio: StremioSync }) {
  const { connection, sync } = stremio;
  if (!connection || sync.kind === "failed") return null;
  return (
    <div
      aria-live="polite"
      className="-ml-2.5 min-w-0 text-sm text-black/55 sm:ml-auto"
    >
      {sync.kind === "updating" ? (
        <p
          key="updating"
          className={cn(
            "flex items-center gap-1.5 font-semibold text-warning-700",
            ENTER,
          )}
        >
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
          Updating Stremio…
        </p>
      ) : (
        <div key={sync.kind} className={ENTER}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="quiet"
                size="chip"
                className="pointer-coarse:min-h-11"
              >
                {sync.kind === "updated" ? (
                  <>
                    <Check
                      className="size-3.5 shrink-0 text-success-600"
                      strokeWidth={3}
                    />
                    <span className="font-semibold text-ink">
                      Stremio updated
                    </span>
                  </>
                ) : (
                  <>
                    <MonitorPlay className="size-3.5 shrink-0" />
                    Updates Stremio on save
                  </>
                )}
                <ChevronDown className="size-3.5 shrink-0" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <div className="px-2 py-1.5 text-sm">
                <p className="font-bold text-ink">Stremio updates on save</p>
                <p className="text-pretty text-black/55">
                  {connection.email ? (
                    <>
                      Connected as{" "}
                      <span className="text-ink">
                        {maskEmail(connection.email)}
                      </span>
                    </>
                  ) : (
                    "Your catalog changes reach Stremio when you save."
                  )}
                </p>
                {sync.kind === "updated" && (
                  <p className="mt-1.5 text-pretty text-black/55">
                    {RELOAD_HINT}
                  </p>
                )}
              </div>
              <DropdownMenuItem
                variant="strong"
                onSelect={() => void stremio.disconnect()}
              >
                Disconnect
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  );
}

function ManualSteps({
  accountKey,
  onReinstalled,
}: {
  accountKey: string;
  onReinstalled: () => void;
}) {
  return (
    <div className="space-y-3">
      <ol className="list-decimal space-y-0.5 pl-5 text-sm text-pretty text-warning-900">
        <li>
          Select <strong className="font-semibold">Reinstall</strong>, then
          choose <strong className="font-semibold">Uninstall</strong> in
          Stremio.
        </li>
        <li>
          Select <strong className="font-semibold">Reinstall</strong> again,
          then choose <strong className="font-semibold">Install</strong>.
        </li>
      </ol>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="dark" size="pill-lg" asChild>
          <a {...reinstallLinkProps(accountKey)}>
            <Download className="size-4" />
            Reinstall
          </a>
        </Button>
        <Button
          type="button"
          variant="link-warning"
          size="inline"
          onClick={onReinstalled}
        >
          I did it
        </Button>
      </div>
    </div>
  );
}

const CHOICE_BUTTON =
  "flex flex-col items-start gap-1 rounded-2xl p-4 text-left ring-1 ring-warning-200 transition-[box-shadow,scale] duration-150 ease-out hover:ring-warning-400 active:scale-[0.98] motion-reduce:active:scale-100";

function ChoiceCard({
  accountKey,
  stremio,
  onReinstalled,
}: {
  accountKey: string;
  stremio: StremioSync;
  onReinstalled: () => void;
}) {
  const [manualOpen, setManualOpen] = useState(
    stremio.manualPreferred || !stremio.available,
  );
  const id = useId();

  return (
    <section
      role="status"
      aria-labelledby={`${id}-title`}
      className={cn(
        "space-y-4 rounded-3xl bg-warning-50 p-4 ring-1 ring-warning-200 sm:p-5",
        ENTER,
      )}
    >
      <div>
        <p id={`${id}-title`} className="font-bold text-warning-950">
          Update Stremio with your changes
        </p>
        <p className="mt-0.5 text-sm text-pretty text-warning-900">
          Your catalogs or Actions changed. Stremio keeps showing the old ones
          until it gets the update.
        </p>
      </div>

      {manualOpen ? (
        <div className={cn("space-y-3", ENTER)}>
          <ManualSteps accountKey={accountKey} onReinstalled={onReinstalled} />
          {stremio.available && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-warning-200 pt-3 text-sm text-warning-900">
              <Label htmlFor={`${id}-manual-preference`} variant="plain">
                <Checkbox
                  id={`${id}-manual-preference`}
                  checked={stremio.manualPreferred}
                  onCheckedChange={(checked) =>
                    stremio.setManualPreferred(checked === true)
                  }
                  variant="warning"
                />
                Always reinstall myself
              </Label>
              <Button
                type="button"
                variant="link-warning"
                size="inline"
                onClick={() => void stremio.connect()}
              >
                Update it for me instead
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => void stremio.connect()}
            aria-labelledby={`${id}-auto`}
            aria-describedby={`${id}-badge ${id}-auto-body`}
            className={CHOICE_BUTTON}
          >
            <span className="flex flex-wrap items-center gap-2 font-bold text-ink">
              <Zap className="size-4 text-warning-600" aria-hidden="true" />
              <span id={`${id}-auto`}>Update it for me</span>
              <span
                id={`${id}-badge`}
                className="rounded-full bg-brand px-2 py-0.5 text-2xs font-bold text-black"
              >
                Recommended
              </span>
            </span>
            <span
              id={`${id}-auto-body`}
              className="text-sm text-pretty text-black/55"
            >
              Connect your Stremio account once. Your next saves update Stremio
              on their own.
            </span>
          </button>
          <button
            type="button"
            onClick={() => setManualOpen(true)}
            aria-labelledby={`${id}-manual`}
            aria-describedby={`${id}-manual-body`}
            className={CHOICE_BUTTON}
          >
            <span className="flex items-center gap-2 font-bold text-ink">
              <RefreshCw
                className="size-4 text-warning-700"
                aria-hidden="true"
              />
              <span id={`${id}-manual`}>I'll reinstall myself</span>
            </span>
            <span
              id={`${id}-manual-body`}
              className="text-sm text-pretty text-black/55"
            >
              No account needed. Two steps in Stremio after each change.
            </span>
          </button>
        </div>
      )}
    </section>
  );
}

function OutdatedCard({
  accountKey,
  stremio,
  onReinstalled,
}: {
  accountKey: string;
  stremio: StremioSync;
  onReinstalled: () => void;
}) {
  const [manualOpen, setManualOpen] = useState(false);
  return (
    <section
      role="status"
      className={cn(
        "space-y-3 rounded-3xl bg-warning-50 p-4 ring-1 ring-warning-200 sm:p-5",
        ENTER,
      )}
    >
      <div>
        <p className="font-bold text-warning-950">
          Stremio still shows your old catalogs
        </p>
        <p className="mt-0.5 text-sm text-pretty text-warning-900">
          Your last save is not in Stremio yet.
        </p>
      </div>
      {manualOpen ? (
        <ManualSteps accountKey={accountKey} onReinstalled={onReinstalled} />
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button
            type="button"
            variant="dark"
            size="pill-lg"
            onClick={() => void stremio.retry()}
          >
            Update Stremio now
          </Button>
          <Button
            type="button"
            variant="link-warning"
            size="inline"
            onClick={() => setManualOpen(true)}
          >
            Reinstall myself
          </Button>
        </div>
      )}
    </section>
  );
}

function LinkCard({ stremio }: { stremio: StremioSync }) {
  const { link } = stremio;

  if (link.kind === "switching") {
    return (
      <section
        role="status"
        className={cn(
          "space-y-3 rounded-3xl bg-white p-4 ring-1 ring-black/10 sm:p-5",
          ENTER,
        )}
      >
        <div>
          <p className="font-bold">Connect another Stremio account</p>
          <p className="mt-0.5 text-sm text-pretty text-black/55">
            Stremio connects the account that is signed in on stremio.com. Sign
            out there, sign in with the other account, then get a code.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="dark"
            size="pill-lg"
            onClick={() => void stremio.connect()}
          >
            Get a code
          </Button>
          <Button variant="soft" size="pill-lg" asChild>
            <a
              href="https://www.stremio.com/acc-settings"
              target="_blank"
              rel="noopener noreferrer"
            >
              Open stremio.com
            </a>
          </Button>
          <Button
            type="button"
            variant="soft"
            size="pill-lg"
            onClick={stremio.cancelLink}
          >
            Cancel
          </Button>
        </div>
      </section>
    );
  }

  if (link.kind === "failed") {
    return (
      <div className={ENTER}>
        <Alert size="card">
          <div>
            <AlertTitle>Stremio did not give a code</AlertTitle>
            <AlertDescription className="mt-0.5">
              Stremio did not answer. Nothing changed in your Stremio account.
              Try again in a moment.
            </AlertDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="dark"
              size="pill-lg"
              onClick={() => void stremio.connect()}
            >
              Try again
            </Button>
            <Button
              type="button"
              variant="soft"
              size="pill-lg"
              onClick={stremio.cancelLink}
            >
              Cancel
            </Button>
          </div>
        </Alert>
      </div>
    );
  }

  if (link.kind === "expired") {
    return (
      <div className={ENTER}>
        <Alert size="card">
          <div>
            <AlertTitle>The Stremio code expired</AlertTitle>
            <AlertDescription className="mt-0.5">
              Nothing changed in your Stremio account. Get a new code to try
              again.
            </AlertDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="dark"
              size="pill-lg"
              onClick={() => void stremio.connect()}
            >
              Get a new code
            </Button>
            <Button
              type="button"
              variant="soft"
              size="pill-lg"
              onClick={stremio.cancelLink}
            >
              Cancel
            </Button>
          </div>
        </Alert>
      </div>
    );
  }

  if (link.kind !== "waiting") return null;

  return (
    <section
      role="status"
      className={cn(
        "flex flex-wrap items-center gap-4 rounded-3xl bg-white p-4 ring-1 ring-black/10 sm:p-5",
        ENTER,
      )}
    >
      <div className="min-w-0 flex-1 basis-64 space-y-1">
        <p className="flex items-center gap-2 font-bold">
          <Loader2
            className="size-4 shrink-0 animate-spin text-black/40"
            aria-hidden="true"
          />
          {link.opened ? "Confirm in the Stremio tab" : "Confirm in Stremio"}
        </p>
        <p className="text-sm text-pretty text-black/55">
          {link.opened
            ? "Sign in to Stremio in the tab we opened."
            : "Open Stremio and sign in."}{" "}
          If you are already signed in there, Stremlist connects at once. You
          never type your Stremio password on Stremlist.
        </p>
      </div>
      <div className="flex gap-2">
        {link.link && (
          <Button
            variant={link.opened ? "soft" : "dark"}
            size="pill-lg"
            asChild
          >
            <a href={link.link} target="_blank" rel="noopener noreferrer">
              {link.opened ? "Open Stremio again" : "Open Stremio"}
            </a>
          </Button>
        )}
        <Button
          type="button"
          variant="soft"
          size="pill-lg"
          onClick={stremio.cancelLink}
        >
          Cancel
        </Button>
      </div>
    </section>
  );
}

const FAILURES = {
  unavailable: {
    title: "Saved, but Stremio did not get the update",
    body: "Stremio did not answer. Your changes are safe in Stremlist.",
  },
  "signed-out": {
    title: "Stremio signed Stremlist out",
    body: "This happens when you sign out of stremio.com or change your Stremio password. Your changes are saved.",
  },
  missing: {
    title: "Stremlist is not in this Stremio account",
    body: "It was removed in Stremio, or you connected another account. Stremlist does not add it back without asking you.",
  },
} as const;

function FailureCard({
  accountKey,
  stremio,
  onReinstalled,
}: {
  accountKey: string;
  stremio: StremioSync;
  onReinstalled: () => void;
}) {
  const [manualOpen, setManualOpen] = useState(false);
  if (stremio.sync.kind !== "failed") return null;
  const { reason } = stremio.sync;
  const copy = FAILURES[reason];

  const primary =
    reason === "missing"
      ? { label: "Install it again", run: () => void stremio.installAgain() }
      : reason === "signed-out" || !stremio.connection
        ? { label: "Connect Stremio again", run: () => void stremio.connect() }
        : { label: "Try again", run: () => void stremio.retry() };

  return (
    <div className={ENTER}>
      <Alert variant="warning" size="card">
        <div>
          <AlertTitle>{copy.title}</AlertTitle>
          <AlertDescription className="mt-0.5">{copy.body}</AlertDescription>
        </div>
        {manualOpen ? (
          <ManualSteps accountKey={accountKey} onReinstalled={onReinstalled} />
        ) : (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Button
              type="button"
              variant="dark"
              size="pill-lg"
              onClick={primary.run}
            >
              {primary.label}
            </Button>
            {reason === "missing" && (
              <Button
                type="button"
                variant="link-warning"
                size="inline"
                onClick={() => void stremio.switchAccount()}
              >
                Use another Stremio account
              </Button>
            )}
            <Button
              type="button"
              variant="link-warning"
              size="inline"
              onClick={() => setManualOpen(true)}
            >
              Reinstall myself
            </Button>
          </div>
        )}
      </Alert>
    </div>
  );
}
