import type { Dispatch, SetStateAction } from "react";
import { flushSync } from "react-dom";
import { ArrowDown, ArrowUp, Eye, Settings2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type Disclosure = {
  expanded: boolean;
  setExpanded: Dispatch<SetStateAction<boolean>>;
  /** The ID of the panel that the button opens. */
  controls: string;
};

/** The Preview and Settings toggles of a row, then its Remove button. */
export function RowActions({
  title,
  preview,
  settings,
  onRemove,
  locked = false,
}: {
  title: string;
  preview: Disclosure;
  settings: Disclosure;
  onRemove: () => void;
  locked?: boolean;
}) {
  return (
    <>
      {(
        [
          [preview, "Preview", "Preview", Eye, false],
          [settings, "Settings", "Settings for", Settings2, locked],
        ] as const
      ).map(
        ([
          { expanded, setExpanded, controls },
          tooltip,
          action,
          Icon,
          disabled,
        ]) => (
          <Tooltip key={tooltip} delayDuration={400}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="disclosure"
                size="icon-round"
                aria-expanded={expanded}
                aria-controls={controls}
                aria-label={`${action} ${title}`}
                disabled={disabled}
                onClick={() => setExpanded((current) => !current)}
              >
                <Icon className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent sideOffset={6}>{tooltip}</TooltipContent>
          </Tooltip>
        ),
      )}
      <Button
        type="button"
        variant="ghost-danger"
        size="icon-round"
        aria-label={`Remove ${title}`}
        disabled={locked}
        onClick={onRemove}
      >
        <X className="size-4" />
      </Button>
    </>
  );
}

/**
 * Move up and Move down in a row's settings. The pressed button stays
 * under the pointer and keeps focus while the row moves.
 */
export function CatalogOrderControls({
  title,
  onMoveUp,
  onMoveDown,
}: {
  title: string;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  return (
    <div className="mt-4 border-t border-black/5 pt-4">
      <p className="mb-2 text-xs font-semibold text-black/60">Catalog order</p>
      <div className="flex gap-2">
        {(
          [
            ["up", "Move up", ArrowUp, onMoveUp],
            ["down", "Move down", ArrowDown, onMoveDown],
          ] as const
        ).map(([direction, label, Icon, onMove]) => (
          <button
            key={direction}
            type="button"
            aria-label={`${label}, ${title}`}
            disabled={!onMove}
            onClick={
              onMove
                ? ({ currentTarget }) => {
                    const top = currentTarget.getBoundingClientRect().top;
                    flushSync(onMove);
                    window.scrollBy({
                      top: currentTarget.getBoundingClientRect().top - top,
                      behavior: "instant",
                    });
                    const focusTarget = currentTarget.disabled
                      ? currentTarget.parentElement?.querySelector<HTMLButtonElement>(
                          "button:enabled",
                        )
                      : currentTarget;
                    focusTarget?.focus({ preventScroll: true });
                  }
                : undefined
            }
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-black/5 px-4 text-sm font-semibold transition-[background-color,scale] duration-150 ease-out outline-none enabled:hover:bg-black/10 enabled:active:scale-[0.97] focus-visible:ring-3 focus-visible:ring-brand/50 disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:active:scale-100"
          >
            <Icon className="size-4" />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
