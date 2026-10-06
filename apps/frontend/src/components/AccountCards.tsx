import { useState } from "react";
import { ArrowRight, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import AddonInstallActions from "./AddonInstallActions";
import { cn } from "@/lib/utils";

function KeepUrlWarning() {
  return (
    <div className="flex gap-3 rounded-2xl bg-brand/20 px-4 py-3 text-sm text-black/80 ring-1 ring-brand/50">
      <KeyRound className="mt-0.5 size-4 shrink-0" />
      <p>
        <strong>Keep this Addon URL secret.</strong> It is the only key to your
        Stremlist: anyone who has it can see and change it, so do not share it.
        To come back here later, open Stremlist's settings in Stremio or paste
        this URL on the Stremlist home page.
      </p>
    </div>
  );
}

/**
 * Install card of an Account. "created" adds the warning that the Addon URL
 * is the only credential (ADR 0001).
 */
export function AddonUrlCard({
  accountKey,
  variant,
  reinstallHint,
}: {
  accountKey: string;
  variant: "created" | "install";
  reinstallHint?: boolean;
}) {
  const title =
    variant === "created"
      ? "Your Stremlist is ready"
      : reinstallHint
        ? "Reinstall in Stremio to see your changes"
        : "Install or reinstall in Stremio";
  const body =
    variant === "created"
      ? "Install it in Stremio once. Your Lists then stay up to date on their own."
      : reinstallHint
        ? "Stremio reads the catalogs and Actions only when you install an addon, so your changes appear after you reinstall this Addon URL."
        : "Use these links anytime to open or reinstall your Addon URL in Stremio.";

  return (
    <section
      className={cn(
        "space-y-4 rounded-3xl p-5 ring-1",
        reinstallHint ? "bg-amber-50 ring-amber-200" : "bg-white ring-black/5",
      )}
    >
      <div>
        <h3 className="text-lg font-bold">{title}</h3>
        <p
          className={cn(
            "mt-0.5 text-sm",
            reinstallHint ? "text-amber-900" : "text-black/55",
          )}
        >
          {body}
        </p>
      </div>
      {variant === "created" && <KeepUrlWarning />}
      <AddonInstallActions accountKey={accountKey} />
    </section>
  );
}

/**
 * For installs that still use a Legacy alias: explain why a private Addon URL
 * helps, create it, then show the reinstall steps.
 */
export function LegacyUpgradeCard({
  movedAt,
  onUpgrade,
  onOpen,
}: {
  movedAt: string | null;
  onUpgrade: () => Promise<string | null>;
  onOpen: (accountId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [newId, setNewId] = useState<string | null>(null);

  const upgrade = async () => {
    setBusy(true);
    const id = await onUpgrade();
    setBusy(false);
    if (id) setNewId(id);
  };

  if (newId) {
    return (
      <section
        id="upgrade"
        className="space-y-4 rounded-3xl bg-white p-5 ring-2 ring-brand"
      >
        <div>
          <h3 className="text-lg font-bold">Your private Addon URL is ready</h3>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-black/65">
            <li>Install the new Addon URL in Stremio.</li>
            <li>Remove the old Stremlist from your Stremio addons.</li>
            <li>From now on, configure Stremlist from the new install.</li>
          </ol>
        </div>
        <KeepUrlWarning />
        <AddonInstallActions accountKey={newId} />
        <button
          type="button"
          onClick={() => onOpen(newId)}
          className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-ink px-5 text-sm font-bold text-cloud transition-[scale] active:scale-[0.98]"
        >
          Go to the new configure page
          <ArrowRight className="size-4" />
        </button>
      </section>
    );
  }

  return (
    <section
      id="upgrade"
      className="space-y-3 rounded-3xl bg-ink p-5 text-cloud"
    >
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-brand" />
        <div>
          <h3 className="text-lg font-bold">
            {movedAt
              ? "This install has a private URL now"
              : "Upgrade to a private URL"}
          </h3>
          <p className="mt-1 text-sm text-pretty text-white/65">
            {movedAt
              ? "A private Addon URL was already created from this install, so changes here are not saved. Use the configure page of your new install. Lost it? Create a new private URL."
              : "This install uses your IMDb user ID, which anyone can guess. A private Addon URL is a secret that only you have, so Stremlist can connect Trakt, Simkl and MDBList and show Actions in Stremio. Your Lists come with it. You reinstall once."}
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={upgrade}
        disabled={busy}
        className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-brand px-5 text-sm font-bold text-black transition-[opacity,scale] active:scale-[0.98] disabled:opacity-60"
      >
        {busy && <Loader2 className="size-4 animate-spin" />}
        {movedAt ? "Create a new private URL" : "Create my private URL"}
      </button>
    </section>
  );
}
