// PROTOTYPE (STR-106 poster UI). Throwaway: never merge into main.
// A floating bar that cycles `?variant=` on the current route. Dev only.
import { useEffect } from "react";
import { useSearchParams } from "react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";

export function PrototypeSwitcher({
  variants,
  current,
  state,
}: {
  variants: { key: string; name: string }[];
  current: string;
  /** What the variant would save, shown so each switch is visible. */
  state: string;
}) {
  const [, setSearchParams] = useSearchParams();
  const index = Math.max(
    0,
    variants.findIndex((variant) => variant.key === current),
  );
  const go = (delta: number) => {
    const next = variants[(index + delta + variants.length) % variants.length];
    setSearchParams(
      (params) => {
        params.set("variant", next.key);
        return params;
      },
      { replace: true },
    );
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.matches("input, textarea, [contenteditable]") ||
          target.closest("[role=listbox]"))
      )
        return;
      if (event.key === "ArrowLeft") go(-1);
      if (event.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!import.meta.env.DEV) return null;
  const variant = variants[index];
  return (
    <div className="fixed bottom-4 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-2 rounded-full bg-fuchsia-600 px-2 py-1.5 font-mono text-xs text-white shadow-lg ring-2 ring-white">
      <button
        type="button"
        aria-label="Previous variant"
        onClick={() => go(-1)}
        className="rounded-full p-1 hover:bg-white/20"
      >
        <ChevronLeft className="size-4" />
      </button>
      <span className="whitespace-nowrap">
        PROTOTYPE {variant.key} ({variant.name}) · {state}
      </span>
      <button
        type="button"
        aria-label="Next variant"
        onClick={() => go(1)}
        className="rounded-full p-1 hover:bg-white/20"
      >
        <ChevronRight className="size-4" />
      </button>
    </div>
  );
}
