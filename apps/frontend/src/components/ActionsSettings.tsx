import { useId } from "react";
import { ArrowDown, ArrowUp, ExternalLink } from "lucide-react";
import { joinProviderLabels, PROVIDERS } from "@stremlist/shared/providers";
import type { ActionKind, ProviderId } from "@stremlist/shared/providers";
import { ADDON_MANAGER_URL } from "@/lib/list-sources";
import { ACTION_PROVIDERS } from "@/lib/provider-groups";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ProviderMark } from "./brand";

const ACTION_LABELS: Record<ActionKind, string> = {
  watchlist: "watchlist",
  watched: "watched",
  rating: "rating",
};

/**
 * Actions settings (ADR 0003): off by default, then an ordered choice of the
 * connected Providers whose Actions show on each title page in Stremio.
 */
export default function ActionsSettings({
  enabled,
  onEnabledChange,
  order,
  selected,
  onToggle,
  onMove,
  locked,
}: {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  /** Connected Providers that support Actions, in the chosen order. */
  order: ProviderId[];
  selected: ProviderId[];
  onToggle: (provider: ProviderId, selected: boolean) => void;
  onMove: (provider: ProviderId, delta: -1 | 1) => void;
  /** Why Actions cannot be turned on here, if they cannot. */
  locked?: string;
}) {
  const toggleId = useId();

  return (
    <section className="rounded-3xl bg-white p-4 ring-1 ring-black/5 sm:p-5">
      <div className="flex items-start gap-3">
        <Checkbox
          id={toggleId}
          checked={enabled}
          disabled={!!locked}
          onCheckedChange={(next) => onEnabledChange(next === true)}
          className="mt-1"
        />
        <div className="min-w-0">
          <label htmlFor={toggleId} className="cursor-pointer font-bold">
            Show Actions in Stremio
          </label>
          <p className="mt-0.5 text-sm text-pretty text-black/55">
            Add to watchlist, mark as watched or rate a title on your connected
            accounts, from its page in Stremio. Each Action opens a small
            Stremlist page that confirms the change.
          </p>
        </div>
      </div>

      {locked ? (
        <p className="mt-3 rounded-2xl bg-black/5 px-4 py-3 text-sm text-black/60">
          {locked}
        </p>
      ) : (
        <div
          className={cn(
            "mt-4 space-y-4 transition-opacity",
            !enabled && "opacity-50",
          )}
        >
          {order.length === 0 ? (
            <p className="rounded-2xl bg-black/5 px-4 py-3 text-sm text-black/60">
              {`Connect ${joinProviderLabels(ACTION_PROVIDERS, "or")} to use Actions.`}
            </p>
          ) : (
            <div>
              <p className="mb-2 text-xs font-semibold text-black/60">
                Accounts, in the order Stremio shows them
              </p>
              <ol className="space-y-1.5">
                {order.map((provider, index) => {
                  const checked = selected.includes(provider);
                  const checkboxId = `${toggleId}-${provider}`;
                  return (
                    <li
                      key={provider}
                      className="flex items-center gap-3 rounded-2xl bg-black/[0.03] px-3 py-2"
                    >
                      <Checkbox
                        id={checkboxId}
                        checked={checked}
                        disabled={!enabled}
                        onCheckedChange={(next) =>
                          onToggle(provider, next === true)
                        }
                      />
                      <ProviderMark
                        provider={provider}
                        active={checked && enabled}
                        className="size-7"
                      />
                      <label
                        htmlFor={checkboxId}
                        className="min-w-0 flex-1 cursor-pointer leading-tight"
                      >
                        <span className="block text-sm font-semibold">
                          {PROVIDERS[provider].label}
                        </span>
                        <span className="block truncate text-xs text-black/50">
                          {PROVIDERS[provider].actions
                            .map((kind) => ACTION_LABELS[kind])
                            .join(", ")}
                        </span>
                      </label>
                      <div className="flex shrink-0 gap-0.5">
                        <Button
                          type="button"
                          variant="quiet"
                          size="icon-round"
                          aria-label={`Move ${PROVIDERS[provider].label} up`}
                          disabled={!enabled || index === 0}
                          onClick={() => onMove(provider, -1)}
                        >
                          <ArrowUp className="size-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="quiet"
                          size="icon-round"
                          aria-label={`Move ${PROVIDERS[provider].label} down`}
                          disabled={!enabled || index === order.length - 1}
                          onClick={() => onMove(provider, 1)}
                        >
                          <ArrowDown className="size-4" />
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}

          <ul className="space-y-1.5 text-sm text-black/60">
            <li>
              Stremio lists an addon's entries in your addon order, and new
              addons go last. To see Actions at the top, move Stremlist just
              after Cinemeta with{" "}
              <a
                href={ADDON_MANAGER_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 font-semibold text-stremlist hover:underline"
              >
                Stremio Addon Manager
                <ExternalLink className="size-3" />
              </a>
              .
            </li>
            <li>
              Actions are not available on LG and Samsung TVs, because Stremio
              cannot open web pages there.
            </li>
          </ul>
        </div>
      )}
    </section>
  );
}
