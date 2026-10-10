import { useState } from "react";
import {
  ArrowRight,
  Download,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { joinProviderLabels } from "@stremlist/shared/providers";
import AddonInstallActions from "./AddonInstallActions";
import { buildAddonUrls } from "@/lib/list-sources";
import { CONNECTABLE_PROVIDERS } from "@/lib/provider-groups";
import type { ReinstallState } from "@/lib/reinstall";
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
  onUse,
}: {
  accountKey: string;
  variant: "created" | "install";
  reinstallHint?: boolean;
  onUse?: () => void;
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
      <AddonInstallActions accountKey={accountKey} onUse={onUse} />
    </section>
  );
}

/** Opens the app, or Stremio Web when the Addon URL has no deep link. */
function reinstallLinkProps(accountKey: string) {
  const { stremioUrl, webUrl } = buildAddonUrls(accountKey);
  return stremioUrl
    ? { href: stremioUrl }
    : { href: webUrl, target: "_blank", rel: "noopener noreferrer" };
}

/**
 * Tells the user when catalog changes need a reinstall: before saving, so
 * they know what to expect, and after saving, until they reinstall. Other
 * changes (sort order, filters, posters) apply without one.
 */
export function ReinstallNotice({
  accountKey,
  state,
  onReinstalled,
}: {
  accountKey: string;
  state: Exclude<ReinstallState, "none">;
  onReinstalled: () => void;
}) {
  if (state === "after-save") {
    return (
      <p className="flex gap-2.5 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-pretty text-amber-900 ring-1 ring-amber-200">
        <RefreshCw className="mt-0.5 size-4 shrink-0" />
        <span>
          <strong className="font-semibold">
            These changes need a reinstall.
          </strong>{" "}
          Stremio reads catalogs and Actions only when you install the addon, so
          save, then reinstall Stremlist.
        </span>
      </p>
    );
  }

  return (
    <section
      role="status"
      className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-3xl bg-amber-50 p-4 ring-1 ring-amber-200 sm:p-5"
    >
      <div className="min-w-0 flex-1 basis-64">
        <p className="font-bold text-amber-950">
          Reinstall Stremlist in Stremio
        </p>
        <p className="mt-0.5 text-sm text-pretty text-amber-900">
          Your catalogs or Actions changed. Stremio keeps showing the old ones
          until you reinstall the addon.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onReinstalled}
          className="text-sm font-semibold text-amber-900 underline-offset-2 hover:underline"
        >
          I did it
        </button>
        <a
          {...reinstallLinkProps(accountKey)}
          onClick={onReinstalled}
          className="inline-flex h-10 items-center gap-2 rounded-full bg-ink px-5 text-sm font-bold text-cloud transition-[background-color,scale] duration-150 ease-out hover:bg-black active:scale-[0.97] motion-reduce:active:scale-100"
        >
          <Download className="size-4" />
          Reinstall
        </a>
      </div>
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
              : `This install uses your IMDb user ID, which anyone can guess. A private Addon URL is a secret that only you have, so Stremlist can connect ${joinProviderLabels(CONNECTABLE_PROVIDERS)} and show Actions in Stremio. Your Lists come with it. You reinstall once.`}
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
