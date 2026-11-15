import { KeyRound } from "lucide-react";
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
