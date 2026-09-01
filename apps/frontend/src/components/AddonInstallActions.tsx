import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface AddonInstallActionsProps {
  imdbUserId: string;
  className?: string;
}

function buildUrls(imdbUserId: string) {
  const addonUrl = `${import.meta.env.VITE_BACKEND_URL}/${imdbUserId}/manifest.json`;
  const webUrl = `https://web.stremio.com/#/addons?addon=${encodeURIComponent(addonUrl)}`;
  const stremioUrl = `stremio://${addonUrl.replace(/^https?:\/\//, "")}`;
  return { addonUrl, webUrl, stremioUrl };
}

export default function AddonInstallActions({
  imdbUserId,
  className,
}: AddonInstallActionsProps) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const urls = buildUrls(imdbUserId);

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
    <div className={className ?? "space-y-5"}>
      <div className="flex flex-col sm:flex-row gap-3">
        <Button asChild className="flex-1 bg-blue-500 hover:bg-blue-600 h-11">
          <a href={urls.webUrl} target="_blank" rel="noopener noreferrer">
            Open in Stremio Web
          </a>
        </Button>
        <Button asChild className="flex-1 bg-green-500 hover:bg-green-600 h-11">
          <a href={urls.stremioUrl}>Open in Stremio Desktop</a>
        </Button>
      </div>

      <div>
        <p className="text-sm text-gray-600 mb-2">
          Or copy this URL and add it manually in Stremio:
        </p>
        <div className="flex gap-2">
          <Input
            type="text"
            readOnly
            value={urls.addonUrl}
            className="flex-1 font-mono text-sm bg-white"
          />
          <Button
            onClick={handleCopy}
            variant="ghost"
            aria-label={copied ? "Manifest URL copied" : "Copy manifest URL"}
          >
            {copied ? <Check /> : <Copy />}
          </Button>
        </div>
        {copyError && (
          <p role="alert" className="mt-2 text-sm text-red-600">
            Could not copy the manifest URL. Select it and copy it manually.
          </p>
        )}
      </div>
    </div>
  );
}
