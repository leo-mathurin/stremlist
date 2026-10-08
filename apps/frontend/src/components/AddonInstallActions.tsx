import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Check, Download, Globe } from "lucide-react";
import { buildAddonUrls } from "@/lib/list-sources";
import { cn } from "@/lib/utils";

const edgeBlurClassName =
  "pointer-events-none absolute inset-y-0 w-10 opacity-0 backdrop-blur-[2px] transition-opacity duration-200 ease-out-quint";

const swapClassName =
  "transition-[opacity,scale,filter] duration-200 ease-out-quint";

/** Reduced motion keeps the crossfade and drops the scale. */
const swapHiddenClassName =
  "scale-50 opacity-0 blur-[2px] motion-reduce:scale-100";

interface AddonInstallActionsProps {
  /** A private Account ID or a Legacy alias. */
  accountKey: string;
  className?: string;
  /** Called when the user installs, opens Stremio Web or copies the URL. */
  onUse?: () => void;
}

/** Install links and the copyable Addon URL of one Account. */
export default function AddonInstallActions({
  accountKey,
  className,
  onUse,
}: AddonInstallActionsProps) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [overflow, setOverflow] = useState({ start: false, end: false });
  const copiedTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  const urlInput = useRef<HTMLInputElement>(null);
  const urls = buildAddonUrls(accountKey);

  // Shows the edge fade only on the sides where the Addon URL is cut off.
  const updateOverflow = useCallback(() => {
    const input = urlInput.current;
    if (!input) return;
    const maxScroll = input.scrollWidth - input.clientWidth;
    const start = input.scrollLeft > 1;
    const end = input.scrollLeft < maxScroll - 1;
    setOverflow((previous) =>
      previous.start === start && previous.end === end
        ? previous
        : { start, end },
    );
  }, []);

  useEffect(() => {
    const input = urlInput.current;
    if (!input) return;
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(input);
    return () => observer.disconnect();
  }, [updateOverflow, urls.addonUrl]);

  useEffect(() => () => clearTimeout(copiedTimeout.current), []);

  const handleCopy = async () => {
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(urls.addonUrl);
      onUse?.();
      setCopied(true);
      clearTimeout(copiedTimeout.current);
      copiedTimeout.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
      setCopyError(true);
    }
  };

  return (
    <div className={cn("space-y-4", className)}>
      <div className="flex flex-col gap-2 sm:flex-row">
        {urls.stremioUrl && (
          <a
            href={urls.stremioUrl}
            onClick={onUse}
            className="inline-flex h-11 w-full items-center sm:flex-1 justify-center gap-2 rounded-full bg-brand px-5 text-sm font-bold text-black transition-[background-color,scale] duration-150 hover:bg-brand-dark active:scale-[0.97]"
          >
            <Download className="size-4" />
            Install in Stremio
          </a>
        )}
        <a
          href={urls.webUrl}
          onClick={onUse}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-11 w-full items-center sm:flex-1 justify-center gap-2 rounded-full border border-black/15 bg-white px-5 text-sm font-semibold text-ink transition-[background-color,scale] duration-150 hover:bg-black/5 active:scale-[0.97]"
        >
          <Globe className="size-4" />
          Open Stremio Web
        </a>
      </div>

      <div>
        <p className="mb-1.5 text-xs font-semibold text-black/55">
          Or copy your Addon URL and add it manually in Stremio:
        </p>
        <div className="flex items-center gap-1 rounded-2xl bg-black/5 p-1">
          <div className="relative min-w-0 flex-1">
            {/* An indent instead of padding: it scrolls with the text, so the
                text reaches the faded edges. */}
            <input
              ref={urlInput}
              type="text"
              readOnly
              value={urls.addonUrl}
              aria-label="Addon URL"
              onFocus={(event) => event.currentTarget.select()}
              onScroll={updateOverflow}
              data-overflow-start={overflow.start || undefined}
              data-overflow-end={overflow.end || undefined}
              className="edge-fade w-full bg-transparent py-2 indent-3 font-mono text-xs text-ink outline-none sm:text-sm"
            />
            <span
              aria-hidden
              className={cn(
                edgeBlurClassName,
                "left-0 mask-[linear-gradient(to_right,#000,transparent)]",
                overflow.start && "opacity-100",
              )}
            />
            <span
              aria-hidden
              className={cn(
                edgeBlurClassName,
                "right-0 mask-[linear-gradient(to_left,#000,transparent)]",
                overflow.end && "opacity-100",
              )}
            />
          </div>
          <button
            type="button"
            onClick={handleCopy}
            aria-label={copied ? "Addon URL copied" : "Copy Addon URL"}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-white px-3 text-xs font-bold text-ink shadow-xs transition-[background-color,scale] duration-150 hover:bg-cloud active:scale-[0.97]"
          >
            {/* Both states stay stacked so the button keeps one width. */}
            <span className="grid *:col-start-1 *:row-start-1">
              <Copy
                className={cn(
                  "size-4",
                  swapClassName,
                  copied && swapHiddenClassName,
                )}
              />
              <Check
                className={cn(
                  "size-4",
                  swapClassName,
                  !copied && swapHiddenClassName,
                )}
              />
            </span>
            <span className="grid justify-items-center *:col-start-1 *:row-start-1">
              <span
                className={cn(swapClassName, copied && swapHiddenClassName)}
              >
                Copy
              </span>
              <span
                className={cn(swapClassName, !copied && swapHiddenClassName)}
              >
                Copied
              </span>
            </span>
          </button>
        </div>
        {copyError && (
          <p role="alert" className="mt-2 text-sm text-red-600">
            Could not copy the Addon URL. Select it and copy it manually.
          </p>
        )}
      </div>
    </div>
  );
}
