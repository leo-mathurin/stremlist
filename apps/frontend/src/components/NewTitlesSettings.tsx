import { useId } from "react";
import type { NewTitlesSummary } from "@stremlist/shared/stremio.types";
import { Sparkles } from "lucide-react";
import { cn, formatRelativeTime } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";
import { BRAND_CHECKBOX } from "./ActionsSettings";

function plural(count: number, one: string, other: string): string {
  return `${count} ${count === 1 ? one : other}`;
}

/** What Stremlist detected so far, or why nothing is detected yet. */
function summaryText(summary: NewTitlesSummary): string {
  const waiting =
    summary.waitingLists > 0
      ? ` Stremlist could not read ${plural(summary.waitingLists, "List", "Lists")} in full yet, so it cannot compare ${summary.waitingLists === 1 ? "it" : "them"}.`
      : "";
  if (summary.detected === 0) {
    return `No new titles detected yet.${waiting}`;
  }
  return `${plural(summary.detected, "new title", "new titles")} detected, the latest ${formatRelativeTime(summary.latestDetectedAt)}.${waiting}`;
}

/**
 * The "New titles" catalog setting (ADR 0007): one extra catalog with the
 * Titles that Stremlist detects in the Lists, newest first.
 */
export default function NewTitlesSettings({
  enabled,
  onEnabledChange,
  summary,
  locked,
}: {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  /** Null for a new setup or when the history cannot be read. */
  summary: NewTitlesSummary | null;
  /** Why the setting cannot change here, if it cannot. */
  locked?: string;
}) {
  const toggleId = useId();
  const descriptionId = `${toggleId}-description`;

  return (
    <section className="rounded-3xl bg-white p-4 ring-1 ring-black/5 sm:p-5">
      <div className="flex items-start gap-3">
        <Checkbox
          id={toggleId}
          checked={enabled}
          disabled={!!locked}
          aria-describedby={descriptionId}
          onCheckedChange={(next) => onEnabledChange(next === true)}
          className={cn("mt-1", BRAND_CHECKBOX)}
        />
        <div className="min-w-0">
          <label htmlFor={toggleId} className="cursor-pointer font-bold">
            Show newly detected titles
          </label>
          <p
            id={descriptionId}
            className="mt-0.5 text-sm text-pretty text-black/55"
          >
            Adds a “New titles” catalog to Stremio with the titles that appear
            in your Lists, newest first and each title once. Titles that were
            already there when Stremlist first read a List do not count as new.
          </p>
        </div>
      </div>

      {locked ? (
        <p className="mt-3 rounded-2xl bg-black/5 px-4 py-3 text-sm text-black/60">
          {locked}
        </p>
      ) : (
        summary && (
          <p className="mt-3 flex items-start gap-2.5 rounded-2xl bg-black/[0.03] px-4 py-3 text-sm text-pretty text-black/60 tabular-nums">
            <Sparkles
              className="mt-0.5 size-4 shrink-0 text-black/40"
              aria-hidden="true"
            />
            <span>{summaryText(summary)}</span>
          </p>
        )
      )}

      <p className="mt-3 text-sm text-pretty text-black/45">
        Dates show when Stremlist detected a title, which can be later than when
        you added it.
      </p>
    </section>
  );
}
