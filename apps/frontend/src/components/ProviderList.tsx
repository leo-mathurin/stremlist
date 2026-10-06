import { useState } from "react";
import type { ReactNode } from "react";
import { Check, Loader2 } from "lucide-react";
import { PROVIDERS } from "@stremlist/shared/providers";
import type { ProviderId } from "@stremlist/shared/providers";
import type { ConnectionSummary } from "@stremlist/shared/stremio.types";
import type {
  AccountAccess,
  ProviderStatus,
} from "@/hooks/useAccountConfiguration";
import { PROVIDER_ORDER } from "@/lib/list-sources";
import { cn } from "@/lib/utils";
import { ProviderMark } from "./brand";

function subtitle(
  provider: ProviderId,
  connection: ConnectionSummary | undefined,
): string {
  if (connection?.needsRenewalSince) return "Needs renewal";
  if (connection) {
    return connection.username ? `@${connection.username}` : "Connected";
  }
  switch (PROVIDERS[provider].connection) {
    case "none":
      return "Paste a link";
    case "optional":
      return "Paste a link, or connect";
    default:
      return "Connect to add lists";
  }
}

/**
 * The Providers column of the configure page. A pasted link highlights its
 * Provider; Providers with OAuth get Connect and Disconnect.
 */
export default function ProviderList({
  access,
  detected,
  connections,
  providerStatus,
  connecting,
  connectLocked,
  affectedLists,
  onConnect,
  onDisconnect,
}: {
  access: AccountAccess;
  detected: ProviderId | null;
  connections: ConnectionSummary[];
  providerStatus: Record<ProviderId, ProviderStatus>;
  connecting: ProviderId | null;
  /** Why Connect is off here (an install that moved to a private URL). */
  connectLocked?: string;
  /** How many Lists each Provider's Connection reads. */
  affectedLists: Partial<Record<ProviderId, number>>;
  onConnect: (provider: ProviderId) => void;
  onDisconnect: (provider: ProviderId) => void;
}) {
  const [confirming, setConfirming] = useState<ProviderId | null>(null);

  return (
    <ul className="space-y-1">
      {PROVIDER_ORDER.map((id) => {
        const info = PROVIDERS[id];
        const status = providerStatus[id];
        const connection = connections.find((c) => c.provider === id);
        const isDetected = detected === id;
        const soon = info.availability !== "available";
        const canConnect =
          info.connection !== "none" &&
          status.connectable &&
          status.enabled &&
          !soon;
        const busy = connecting === id;

        let trailing: ReactNode;
        if (isDetected) {
          trailing = (
            <span className="text-xs font-semibold text-brand">
              {soon ? "Coming soon" : "Link detected"}
            </span>
          );
        } else if (soon) {
          trailing = (
            <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-white/50">
              Soon
            </span>
          );
        } else if (!status.enabled) {
          trailing = (
            <span className="text-right text-xs text-white/45">
              Temporarily unavailable
            </span>
          );
        } else if (connection?.needsRenewalSince) {
          // The Provider refuses the Connection: connecting again renews it.
          trailing = (
            <span className="flex items-center gap-1">
              {canConnect && (
                <button
                  type="button"
                  onClick={() => onConnect(id)}
                  disabled={connecting !== null || !!connectLocked}
                  title={connectLocked}
                  className="inline-flex items-center gap-1.5 rounded-full bg-brand px-3 py-1 text-xs font-bold text-black transition-[background-color,scale] duration-150 hover:bg-brand-dark active:scale-[0.96] disabled:opacity-40"
                >
                  {busy && <Loader2 className="size-3.5 animate-spin" />}
                  <span className="sm:hidden">Reconnect</span>
                  <span className="hidden sm:inline">Connect again</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => setConfirming(id)}
                disabled={busy || confirming === id}
                aria-expanded={confirming === id}
                className="rounded-full px-2.5 py-1 text-xs font-semibold text-white/55 transition-colors hover:bg-white/10 hover:text-cloud disabled:opacity-40"
              >
                {busy ? "Disconnecting" : "Disconnect"}
              </button>
            </span>
          );
        } else if (connection) {
          trailing = (
            <span className="flex items-center gap-2">
              <span className="hidden items-center gap-1 text-xs font-bold text-brand sm:flex">
                <Check className="size-3.5" />
                Connected
              </span>
              <button
                type="button"
                onClick={() => setConfirming(id)}
                disabled={busy || confirming === id}
                aria-expanded={confirming === id}
                className="rounded-full px-2.5 py-1 text-xs font-semibold text-white/55 transition-colors hover:bg-white/10 hover:text-cloud disabled:opacity-40"
              >
                {busy ? "Disconnecting" : "Disconnect"}
              </button>
            </span>
          );
        } else if (canConnect) {
          trailing = (
            <button
              type="button"
              onClick={() => onConnect(id)}
              disabled={connecting !== null || !!connectLocked}
              title={
                connectLocked
                  ? connectLocked
                  : access === "legacy"
                    ? "Needs a private Addon URL"
                    : access === "new"
                      ? "Saves your setup first"
                      : undefined
              }
              className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.12] px-3 py-1 text-xs font-bold text-cloud transition-colors hover:bg-white/20 disabled:opacity-40"
            >
              {busy && <Loader2 className="size-3.5 animate-spin" />}
              Connect
            </button>
          );
        } else if (info.connection === "required") {
          trailing = (
            <span className="text-right text-xs text-white/45">
              Not available yet
            </span>
          );
        } else {
          trailing = <span className="text-xs text-white/40">Link</span>;
        }

        const affected = affectedLists[id] ?? 0;
        return (
          <li
            key={id}
            className={cn(
              "rounded-2xl px-3 py-2 transition-colors duration-200",
              isDetected && "bg-brand/[0.16]",
              confirming === id && "bg-white/[0.06]",
            )}
          >
            <div className="flex min-h-8 items-center gap-3">
              <ProviderMark
                provider={id}
                tone="dark"
                active={!!connection || isDetected}
              />
              <span className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className={cn("font-semibold", soon && "text-white/45")}>
                  {info.label}
                </span>
                <span
                  className={cn(
                    "truncate text-xs",
                    connection?.needsRenewalSince
                      ? "font-semibold text-amber-300"
                      : "text-white/45",
                  )}
                >
                  {soon ? "Not supported yet" : subtitle(id, connection)}
                </span>
              </span>
              <span className="shrink-0">{trailing}</span>
            </div>
            {!connection && canConnect && info.connectNote && (
              <p className="mt-1 ml-11 text-xs text-pretty text-white/45">
                {info.connectNote}
              </p>
            )}
            {confirming === id && connection && (
              <div
                role="group"
                aria-label={`Disconnect ${info.label}?`}
                className="mt-2 ml-11 space-y-2 text-xs text-white/70"
              >
                <p className="text-pretty">
                  <strong className="text-cloud">
                    Disconnect {info.label}?
                  </strong>{" "}
                  {affected > 0
                    ? `${affected === 1 ? "1 List is" : `${affected} Lists are`} read through this account. ${affected === 1 ? "It stops" : "They stop"} showing in Stremio until you connect ${info.label} again.`
                    : `Lists read through this account stop showing in Stremio until you connect ${info.label} again.`}{" "}
                  {info.actions.length > 0 &&
                    `Actions on ${info.label} stop too.`}
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setConfirming(null);
                      onDisconnect(id);
                    }}
                    className="rounded-full bg-red-500/90 px-3 py-1 font-bold text-white transition-colors hover:bg-red-500"
                  >
                    Disconnect
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(null)}
                    className="rounded-full bg-white/[0.12] px-3 py-1 font-bold text-cloud transition-colors hover:bg-white/20"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
