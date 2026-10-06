import { useState } from "react";
import { Copy, Check, Download, Globe } from "lucide-react";
import { buildAddonUrls } from "@/lib/list-sources";
import { cn } from "@/lib/utils";

interface AddonInstallActionsProps {
  /** A private Account ID or a Legacy alias. */
  accountKey: string;
  className?: string;
}

/** Install links and the copyable Addon URL of one Account. */
export default function AddonInstallActions({
  accountKey,
  className,
}: AddonInstallActionsProps) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const urls = buildAddonUrls(accountKey);

  const handleCopy = async () => {
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(urls.addonUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
      setCopyError(true);
    }
  };

  return (
    <div className={cn("space-y-4", className)}>
      <div className="flex flex-col gap-2 sm:flex-row">
        <a
          href={urls.stremioUrl}
          className="inline-flex h-11 w-full items-center sm:flex-1 justify-center gap-2 rounded-full bg-brand px-5 text-sm font-bold text-black transition-[background-color,scale] duration-150 hover:bg-brand-dark active:scale-[0.97]"
        >
          <Download className="size-4" />
          Install in Stremio
        </a>
        <a
          href={urls.webUrl}
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
          <input
            type="text"
            readOnly
            value={urls.addonUrl}
            aria-label="Addon URL"
            onFocus={(event) => event.currentTarget.select()}
            className="min-w-0 flex-1 bg-transparent px-3 py-2 font-mono text-xs text-ink outline-none sm:text-sm"
          />
          <button
            type="button"
            onClick={handleCopy}
            aria-label={copied ? "Addon URL copied" : "Copy Addon URL"}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-white px-3 text-xs font-bold text-ink shadow-xs transition-colors hover:bg-cloud"
          >
            {copied ? (
              <Check className="size-4" />
            ) : (
              <Copy className="size-4" />
            )}
            {copied ? "Copied" : "Copy"}
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
