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
  onConnect,
  onDisconnect,
}: {
  access: AccountAccess;
  detected: ProviderId | null;
  connections: ConnectionSummary[];
  providerStatus: Record<ProviderId, ProviderStatus>;
  connecting: ProviderId | null;
  onConnect: (provider: ProviderId) => void;
  onDisconnect: (provider: ProviderId) => void;
}) {
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
        } else if (connection) {
          trailing = (
            <span className="flex items-center gap-2">
              <span className="hidden items-center gap-1 text-xs font-bold text-brand sm:flex">
                <Check className="size-3.5" />
                Connected
              </span>
              <button
                type="button"
                onClick={() => onDisconnect(id)}
                disabled={busy}
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
              disabled={connecting !== null}
              title={
                access === "legacy"
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

        return (
          <li
            key={id}
            className={cn(
              "flex min-h-12 items-center gap-3 rounded-2xl px-3 py-2 transition-colors duration-200",
              isDetected && "bg-brand/[0.16]",
            )}
          >
            <ProviderMark
              provider={id}
              tone="dark"
              active={!!connection || isDetected}
            />
            <span className="flex min-w-0 flex-1 flex-col leading-tight">
              <span className={cn("font-semibold", soon && "text-white/45")}>
                {info.label}
              </span>
              <span className="truncate text-xs text-white/45">
                {soon ? "Not supported yet" : subtitle(id, connection)}
              </span>
            </span>
            <span className="shrink-0">{trailing}</span>
          </li>
        );
      })}
    </ul>
  );
}
