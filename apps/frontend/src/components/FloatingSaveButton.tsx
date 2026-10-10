import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The look of the configure page Save buttons. */
export const SAVE_BUTTON_CLASS =
  "inline-flex shrink-0 items-center justify-center gap-2 bg-brand font-bold text-black hover:bg-brand-dark active:scale-[0.97] disabled:opacity-40 motion-reduce:active:scale-100";

/**
 * The Save button at the end of the configure page. It floats as a pill at
 * the bottom right while `show`, and spans the column once it rests at the
 * end of the page.
 */
export default function FloatingSaveButton({
  show,
  disabled,
  saving,
  onSave,
  children,
}: {
  show: boolean;
  disabled: boolean;
  saving: boolean;
  onSave: () => void;
  /** The label, the same as the header Save button. */
  children: ReactNode;
}) {
  const [bar, setBar] = useState<HTMLDivElement | null>(null);
  const [docked, setDocked] = useState(false);
  // Width of the label, so the clip shows a pill around it while the button
  // floats.
  const [label, setLabel] = useState<HTMLSpanElement | null>(null);
  const [labelWidth, setLabelWidth] = useState(0);
  useEffect(() => {
    if (!bar) return;
    // While stuck, the button sits 20px (bottom-5) above the viewport edge,
    // so it is never fully inside a root shrunk by 22px. Once it rests in
    // place at the end of the page, it is.
    const observer = new IntersectionObserver(
      ([entry]) => setDocked(entry.intersectionRatio === 1),
      { rootMargin: "0px 0px -22px 0px", threshold: 1 },
    );
    observer.observe(bar);
    return () => observer.disconnect();
  }, [bar]);
  useEffect(() => {
    if (!label) return;
    const observer = new ResizeObserver(([entry]) =>
      setLabelWidth(entry.borderBoxSize[0].inlineSize),
    );
    observer.observe(label);
    return () => observer.disconnect();
  }, [label]);

  return (
    <div
      ref={setBar}
      inert={!show}
      className={cn(
        "pointer-events-none sticky bottom-5 z-20 flex justify-end transition-[opacity,translate] ease-out-quint motion-reduce:translate-y-0",
        show ? "duration-200" : "translate-y-4 opacity-0 duration-150",
      )}
    >
      <button
        type="button"
        onClick={onSave}
        disabled={disabled}
        aria-busy={saving}
        style={{ "--pill": `${labelWidth + 64}px` } as CSSProperties}
        className={cn(
          SAVE_BUTTON_CLASS,
          // Always full width; while floating, the clip shows only a pill at
          // the right. At the end of the page the clip opens and the label
          // slides to the center.
          "@container pointer-events-auto h-14 w-full text-base [transition:clip-path_250ms_var(--ease-in-out-quart),background-color_150ms_ease-out,opacity_150ms_ease-out,scale_150ms_ease-out] motion-reduce:[transition:background-color_150ms_ease-out,opacity_150ms_ease-out]",
          docked
            ? "[clip-path:inset(0_round_9999px)]"
            : "origin-right [clip-path:inset(0_0_0_calc(100%-var(--pill))_round_9999px)]",
        )}
      >
        <span
          ref={setLabel}
          className={cn(
            "inline-flex items-center gap-2 transition-[translate] duration-250 ease-in-out-quart motion-reduce:transition-none",
            !docked && "translate-x-[calc(50cqw-var(--pill)/2)]",
          )}
        >
          {children}
        </span>
      </button>
    </div>
  );
}
