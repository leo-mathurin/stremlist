import { useEffect, useState } from "react";
import { CircleCheck, TriangleAlert } from "lucide-react";
import type { ProviderId } from "@stremlist/shared/providers";
import type { ProviderStatus } from "@/hooks/useProviderStatus";
import {
  earliestOutage,
  outageCopy,
  outageProviders,
  recoveredCopy,
  recoveredProviders,
} from "@/lib/provider-outages";
import { cn } from "@/lib/utils";
import RelativeTime from "./RelativeTime";
import { ENTER } from "./StremioUpdateNotice";

const RECOVERED_MS = 8_000;

/**
 * One banner for every Provider with an outage, so the user knows that a
 * list which does not update is the Provider's problem, not their setup.
 * When an outage ends, a short note says so. A visually hidden live region
 * stays in the page, so screen readers announce both without adding space.
 */
export default function ProviderOutageBanner({
  providerStatus,
}: {
  providerStatus: Record<ProviderId, ProviderStatus>;
}) {
  const down = outageProviders(providerStatus);
  const downKey = down.join(",");
  const [seenDown, setSeenDown] = useState<{
    key: string;
    ids: ProviderId[];
  }>({ key: "", ids: [] });
  const [recovered, setRecovered] = useState<ProviderId[]>([]);

  if (seenDown.key !== downKey) {
    const ended = recoveredProviders(seenDown.ids, providerStatus);
    setSeenDown({ key: downKey, ids: down });
    if (ended.length > 0) setRecovered(ended);
  }

  useEffect(() => {
    if (recovered.length === 0) return;
    const timer = window.setTimeout(() => setRecovered([]), RECOVERED_MS);
    return () => window.clearTimeout(timer);
  }, [recovered]);

  const back = recovered.filter((id) => !down.includes(id));
  const since = earliestOutage(down, providerStatus);
  const copy = down.length > 0 ? outageCopy(down) : null;

  return (
    <>
      <p role="status" className="sr-only">
        {copy ? `${copy.title}. ` : ""}
        {back.length > 0 ? recoveredCopy(back) : ""}
      </p>
      {copy && (
        <section
          aria-labelledby="provider-outage-title"
          className={cn(
            "flex gap-3 rounded-3xl bg-amber-50 p-4 ring-1 ring-amber-200 sm:p-5",
            ENTER,
          )}
        >
          <TriangleAlert
            className="mt-0.5 size-5 shrink-0 text-amber-600"
            aria-hidden="true"
          />
          <div className="min-w-0 space-y-1">
            <p id="provider-outage-title" className="font-bold text-amber-950">
              {copy.title}
            </p>
            <p className="text-sm text-pretty text-amber-900">{copy.body}</p>
            {since && (
              <p className="text-xs text-amber-800/80 tabular-nums">
                Started <RelativeTime iso={since} />
              </p>
            )}
          </div>
        </section>
      )}
      {back.length > 0 && (
        <p
          className={cn(
            "flex items-center gap-2 rounded-3xl bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-900 ring-1 ring-emerald-200",
            ENTER,
          )}
        >
          <CircleCheck
            className="size-4 shrink-0 text-emerald-600"
            aria-hidden="true"
          />
          {recoveredCopy(back)}
        </p>
      )}
    </>
  );
}
