import { useNow } from "@/hooks/useNow";
import { formatRelativeTime } from "@/lib/utils";

/** A relative time ("2 minutes ago") that stays live. */
export default function RelativeTime({
  iso,
}: {
  iso: string | null | undefined;
}) {
  return formatRelativeTime(iso, useNow());
}
