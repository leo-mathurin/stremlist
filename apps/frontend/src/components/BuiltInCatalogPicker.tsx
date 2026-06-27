import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { CHART_REGISTRY } from "@stremlist/shared";
import { Check, ChevronDown, ExternalLink, Plus, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/**
 * Dropdown panel for adding built-in IMDb chart catalogs. Unlike a plain
 * <Select>, each row carries a description and its own "view on IMDb" link, so
 * picking a chart and previewing it on IMDb are two distinct actions.
 */
export default function BuiltInCatalogPicker({
  usedIds,
  disabled,
  onAdd,
}: {
  usedIds: string[];
  disabled?: boolean;
  onAdd: (chartId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Keep the panel mounted through its close animation; Radix's <Select> gets
  // this for free via Presence, so we mirror the data-state pattern by hand.
  // `mounted` is set on open and cleared when the close animation finishes.
  const [mounted, setMounted] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const openMenu = () => {
    setMounted(true);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <Button
        type="button"
        variant="outline"
        onClick={() => (open ? setOpen(false) : openMenu())}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        className="gap-2"
      >
        <Sparkles className="size-4" />
        Add Built-in Catalog
        <ChevronDown
          className={cn(
            "size-4 opacity-50 transition-transform",
            open && "rotate-180",
          )}
        />
      </Button>

      {mounted && (
        <div
          role="menu"
          data-state={open ? "open" : "closed"}
          onAnimationEnd={(event) => {
            // Unmount synchronously on the close animation's end frame so the
            // browser never paints the snap-back from scale(0.95) to scale(1)
            // (tw-animate-css's `animate-out` has no forwards fill-mode).
            if (event.target === event.currentTarget && !open) {
              flushSync(() => setMounted(false));
            }
          }}
          className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-top-2 data-[state=closed]:fill-mode-forwards absolute right-0 z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] origin-top-right overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg"
        >
          <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2">
            <Sparkles className="size-3.5 text-imdb-dark" />
            <p className="text-xs font-semibold text-gray-700">
              Built-in IMDb charts
            </p>
          </div>
          <ul className="max-h-[min(22rem,60vh)] overflow-y-auto p-1.5">
            {CHART_REGISTRY.map((entry) => {
              const added = usedIds.includes(entry.id);
              return (
                <li key={entry.id}>
                  <div
                    className={cn(
                      "flex items-center gap-1 rounded-lg pr-1 transition-colors",
                      added ? "opacity-60" : "hover:bg-gray-50",
                    )}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      disabled={added}
                      onClick={() => {
                        onAdd(entry.id);
                        setOpen(false);
                      }}
                      className="flex flex-1 items-start gap-2.5 rounded-lg px-2 py-2 text-left disabled:cursor-not-allowed"
                    >
                      <span
                        className={cn(
                          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md",
                          added
                            ? "bg-gray-100 text-gray-500"
                            : "bg-imdb/15 text-imdb-dark",
                        )}
                      >
                        {added ? (
                          <Check className="size-3.5" />
                        ) : (
                          <Plus className="size-3.5" />
                        )}
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span className="text-sm font-medium text-gray-900">
                          {entry.label}
                        </span>
                        <span className="text-xs leading-snug text-gray-500">
                          {entry.description}
                        </span>
                      </span>
                    </button>
                    <a
                      href={entry.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(event) => event.stopPropagation()}
                      aria-label={`View ${entry.label} on IMDb`}
                      title="View on IMDb"
                      className="shrink-0 rounded-md p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-stremlist"
                    >
                      <ExternalLink className="size-4" />
                    </a>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
