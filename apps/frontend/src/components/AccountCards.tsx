import { Download, KeyRound, RefreshCw } from "lucide-react";
import AddonInstallActions from "./AddonInstallActions";
import { buildAddonUrls } from "@/lib/list-sources";
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
      ? "Install it in Stremio once. Your lists then stay up to date on their own."
      : reinstallHint
        ? "Stremio reads the catalogs and Actions only when you install an addon. Open your Addon URL in Stremio and choose Uninstall, then open it again and choose Install."
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
 * they know what to expect, and after saving, until they confirm it. Other
 * changes (sort order, filters, posters) apply without one.
 *
 * Stremio offers no update for an installed addon: its addon screen only
 * shows Uninstall, and closes after it. So the reinstall takes the link
 * twice, and opening it does not end the reminder. Only "I did it" does.
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
        <ol className="mt-2 list-decimal space-y-0.5 pl-5 text-sm text-pretty text-amber-900">
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
          className="inline-flex h-10 items-center gap-2 rounded-full bg-ink px-5 text-sm font-bold text-cloud transition-[background-color,scale] duration-150 ease-out hover:bg-black active:scale-[0.97] motion-reduce:active:scale-100"
        >
          <Download className="size-4" />
          Reinstall
        </a>
      </div>
    </section>
  );
}
