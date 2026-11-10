import { useId, useState } from "react";
import { Download, Loader2, MonitorPlay, RefreshCw, Zap } from "lucide-react";
import type { StremioSync } from "@/hooks/useStremioSync";
import { reinstallLinkProps } from "@/lib/list-sources";
import type { ReinstallState } from "@/lib/reinstall";
import { cn } from "@/lib/utils";

// A block that appears in the page: a short rise with a strong ease-out.
// Reduced motion keeps the fade only.
const ENTER =
  "transition-[opacity,translate] duration-200 ease-[var(--ease-out-quint)] starting:translate-y-1.5 starting:opacity-0 motion-reduce:starting:translate-y-0";

const DARK_BUTTON =
  "inline-flex h-10 items-center gap-2 rounded-full bg-ink px-5 text-sm font-bold text-cloud transition-[background-color,scale] duration-150 ease-out hover:bg-black active:scale-[0.97] motion-reduce:active:scale-100";

const LIGHT_BUTTON =
  "inline-flex h-10 items-center rounded-full bg-black/5 px-4 text-sm font-semibold text-ink transition-[background-color,scale] duration-150 ease-out hover:bg-black/10 active:scale-[0.97] motion-reduce:active:scale-100";

const TEXT_BUTTON =
  "text-sm font-semibold text-amber-900 underline-offset-2 hover:underline";

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
    return (
      <div className="space-y-3">
        <StatusCard stremio={stremio} />
        {state === "after-save" && (
          <p className={cn("text-sm text-black/55", ENTER)}>
            Stremio will update when you save.
          </p>
        )}
        {state === "required" && stremio.sync.kind === "idle" && (
          <OutdatedCard
            accountKey={accountKey}
            stremio={stremio}
            onReinstalled={reinstalled}
          />
        )}
      </div>
    );
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
          "flex gap-2.5 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-pretty text-amber-900 ring-1 ring-amber-200",
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
 * The linked account, in a card of its own: the line above it tells when the
 * lists refreshed, which is another thing. Update results are toasts.
 */
function StatusCard({ stremio }: { stremio: StremioSync }) {
  const { connection, sync } = stremio;
  if (!connection) return null;
  return (
    <section className="flex items-center gap-3 rounded-2xl bg-white px-4 py-3 ring-1 ring-black/5">
      <span
        aria-hidden="true"
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-black/5 text-black/60"
      >
        <MonitorPlay className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold">Stremio updates automatically</p>
        <p className="text-sm text-pretty text-black/55">
          {connection.email ? (
            <>
              Connected as{" "}
              <span className="text-ink">{maskEmail(connection.email)}</span>
            </>
          ) : (
            <>Your catalog changes reach Stremio when you save.</>
          )}
        </p>
      </div>
      <button
        type="button"
        disabled={sync.kind === "updating"}
        onClick={() => void stremio.disconnect()}
        className="shrink-0 text-sm font-semibold text-black/45 underline-offset-2 hover:text-ink hover:underline disabled:pointer-events-none disabled:opacity-40"
      >
        Disconnect
      </button>
    </section>
  );
}

/** The two manual steps. Stremio has no update for an installed addon. */
function ManualSteps({
  accountKey,
  onReinstalled,
}: {
  accountKey: string;
  onReinstalled: () => void;
}) {
  return (
    <div className="space-y-3">
      <ol className="list-decimal space-y-0.5 pl-5 text-sm text-pretty text-amber-900">
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
        <a {...reinstallLinkProps(accountKey)} className={DARK_BUTTON}>
          <Download className="size-4" />
          Reinstall
        </a>
        <button type="button" onClick={onReinstalled} className={TEXT_BUTTON}>
          I did it
        </button>
      </div>
    </div>
  );
}

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
        "space-y-4 rounded-3xl bg-amber-50 p-4 ring-1 ring-amber-200 sm:p-5",
        ENTER,
      )}
    >
      <div>
        <p id={`${id}-title`} className="font-bold text-amber-950">
          Update Stremio with your changes
        </p>
        <p className="mt-0.5 text-sm text-pretty text-amber-900">
          Your catalogs or Actions changed. Stremio keeps showing the old ones
          until it gets the update.
        </p>
      </div>

      {manualOpen ? (
        <div className={cn("space-y-3", ENTER)}>
          <ManualSteps accountKey={accountKey} onReinstalled={onReinstalled} />
          {/* A Legacy alias install has no Account to link Stremio to. */}
          {stremio.available && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-amber-200 pt-3 text-sm text-amber-900">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={stremio.manualPreferred}
                  onChange={(event) =>
                    stremio.setManualPreferred(event.target.checked)
                  }
                  className="size-4 accent-amber-700"
                />
                Always reinstall myself
              </label>
              <button
                type="button"
                onClick={() => void stremio.connect()}
                className={TEXT_BUTTON}
              >
                Update it for me instead
              </button>
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
            className="flex flex-col items-start gap-1 rounded-2xl bg-white p-4 text-left ring-1 ring-amber-200 transition-[box-shadow,scale] duration-150 ease-out hover:ring-amber-300 active:scale-[0.98] motion-reduce:active:scale-100"
          >
            <span className="flex flex-wrap items-center gap-2 font-bold text-ink">
              <Zap className="size-4 text-amber-600" aria-hidden="true" />
              <span id={`${id}-auto`}>Update it for me</span>
              <span
                id={`${id}-badge`}
                className="rounded-full bg-brand px-2 py-0.5 text-[11px] font-bold text-black"
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
            className="flex flex-col items-start gap-1 rounded-2xl p-4 text-left ring-1 ring-amber-200/70 transition-[background-color,scale] duration-150 ease-out hover:bg-white/60 active:scale-[0.98] motion-reduce:active:scale-100"
          >
            <span className="flex items-center gap-2 font-bold text-ink">
              <RefreshCw className="size-4 text-amber-700" aria-hidden="true" />
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

/** Linked, but Stremio still reads an older setup: offer the update. */
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
        "space-y-3 rounded-3xl bg-amber-50 p-4 ring-1 ring-amber-200 sm:p-5",
        ENTER,
      )}
    >
      <div>
        <p className="font-bold text-amber-950">
          Stremio still shows your old catalogs
        </p>
        <p className="mt-0.5 text-sm text-pretty text-amber-900">
          Your last save is not in Stremio yet.
        </p>
      </div>
      {manualOpen ? (
        <ManualSteps accountKey={accountKey} onReinstalled={onReinstalled} />
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <button
            type="button"
            onClick={() => void stremio.retry()}
            className={DARK_BUTTON}
          >
            Update Stremio now
          </button>
          <button
            type="button"
            onClick={() => setManualOpen(true)}
            className={TEXT_BUTTON}
          >
            Reinstall myself
          </button>
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
          <button
            type="button"
            onClick={() => void stremio.connect()}
            className={DARK_BUTTON}
          >
            Get a code
          </button>
          <a
            href="https://www.stremio.com/acc-settings"
            target="_blank"
            rel="noopener noreferrer"
            className={LIGHT_BUTTON}
          >
            Open stremio.com
          </a>
          <button
            type="button"
            onClick={stremio.cancelLink}
            className={LIGHT_BUTTON}
          >
            Cancel
          </button>
        </div>
      </section>
    );
  }

  if (link.kind === "expired") {
    return (
      <section
        role="alert"
        className={cn(
          "space-y-3 rounded-3xl bg-white p-4 ring-1 ring-black/10 sm:p-5",
          ENTER,
        )}
      >
        <div>
          <p className="font-bold">The Stremio code expired</p>
          <p className="mt-0.5 text-sm text-pretty text-black/55">
            Nothing changed in your Stremio account. Get a new code to try
            again.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void stremio.connect()}
            className={DARK_BUTTON}
          >
            Get a new code
          </button>
          <button
            type="button"
            onClick={stremio.cancelLink}
            className={LIGHT_BUTTON}
          >
            Cancel
          </button>
        </div>
      </section>
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
          Confirm in the Stremio tab
        </p>
        <p className="text-sm text-pretty text-black/55">
          Sign in to Stremio in the tab we opened. If you are already signed in
          there, Stremlist connects at once. You never type your Stremio
          password on Stremlist.
        </p>
      </div>
      <div className="flex gap-2">
        {link.link && (
          <a
            href={link.link}
            target="_blank"
            rel="noopener noreferrer"
            className={LIGHT_BUTTON}
          >
            Open Stremio again
          </a>
        )}
        <button
          type="button"
          onClick={stremio.cancelLink}
          className={LIGHT_BUTTON}
        >
          Cancel
        </button>
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
    <section
      role="alert"
      className={cn(
        "space-y-3 rounded-3xl bg-amber-50 p-4 ring-1 ring-amber-200 sm:p-5",
        ENTER,
      )}
    >
      <div>
        <p className="font-bold text-amber-950">{copy.title}</p>
        <p className="mt-0.5 text-sm text-pretty text-amber-900">{copy.body}</p>
      </div>
      {manualOpen ? (
        <ManualSteps accountKey={accountKey} onReinstalled={onReinstalled} />
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <button type="button" onClick={primary.run} className={DARK_BUTTON}>
            {primary.label}
          </button>
          {reason === "missing" && (
            <button
              type="button"
              onClick={() => void stremio.switchAccount()}
              className={TEXT_BUTTON}
            >
              Use another Stremio account
            </button>
          )}
          <button
            type="button"
            onClick={() => setManualOpen(true)}
            className={TEXT_BUTTON}
          >
            Reinstall myself
          </button>
        </div>
      )}
    </section>
  );
}
