import { useState, useRef, useCallback, useEffect } from "react";
import { Link } from "react-router";
import { Copy, Check } from "lucide-react";
import { api, BACKEND_URL } from "../lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";

function extractImdbId(text: string): string {
  if (!text) return "";
  const match = text.match(/ur\d+/);
  return match ? match[0] : "";
}

function getInitialUserId(): string {
  const params = new URLSearchParams(window.location.search);
  const userId = params.get("userId");
  return userId && userId.startsWith("ur") && userId.length > 3 ? userId : "";
}

function buildUrls(imdbId: string) {
  const addonUrl = `${BACKEND_URL}/${imdbId}/manifest.json`;
  const webUrl = `https://web.stremio.com/#/addons?addon=${encodeURIComponent(addonUrl)}`;
  const stremioUrl = `stremio://${addonUrl.replace(/^https?:\/\//, "")}`;
  return { addonUrl, webUrl, stremioUrl };
}

type Status = { type: "error" | "success" | "info"; message: string } | null;

export default function SetupForm() {
  const initialUserId = getInitialUserId();
  const [imdbId, setImdbId] = useState(initialUserId);
  const [validId, setValidId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>(
    initialUserId ? { type: "info", message: "Validating IMDb ID..." } : null,
  );
  const [copied, setCopied] = useState(false);
  const [validating, setValidating] = useState(Boolean(initialUserId));
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (initialUserId) {
      api.validate[":userId"]
        .$get({ param: { userId: initialUserId } })
        .then((res) => res.json())
        .then((data) => {
          if (data.valid) {
            setValidId(initialUserId);
            setStatus({
              type: "success",
              message: "Choose how to install below:",
            });
          } else {
            setStatus({
              type: "error",
              message:
                "This IMDb ID does not exist. Please check and try again.",
            });
          }
        })
        .catch(() => {
          setValidId(initialUserId);
          setStatus({
            type: "success",
            message: "Choose how to install below:",
          });
        })
        .finally(() => setValidating(false));
    }
  }, [initialUserId]);

  const handleInput = useCallback((value: string) => {
    setImdbId(value);
    setValidId(null);
    setStatus(null);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    const trimmed = value.trim();
    if (!trimmed) return;

    debounceRef.current = setTimeout(() => {
      const extracted = extractImdbId(trimmed);

      if (!extracted) {
        setStatus({
          type: "error",
          message:
            'Could not find a valid IMDb ID. ID should start with "ur" followed by numbers (e.g., ur12345678)',
        });
        return;
      }

      if (extracted.length <= 3) {
        setStatus({
          type: "error",
          message:
            'Invalid IMDb ID format. ID should have more characters after "ur" (e.g., ur12345678)',
        });
        return;
      }

      if (extracted !== trimmed) {
        setImdbId(extracted);
      }

      setValidating(true);
      setStatus({ type: "info", message: "Validating IMDb ID..." });
      api.validate[":userId"]
        .$get({ param: { userId: extracted } })
        .then((res) => res.json())
        .then((data) => {
          if (data.valid) {
            setValidId(extracted);
            setStatus({
              type: "success",
              message: "Choose how to install below:",
            });
          } else {
            setStatus({
              type: "error",
              message:
                "This IMDb ID does not exist. Please check and try again.",
            });
          }
        })
        .catch(() => {
          setValidId(extracted);
          setStatus({
            type: "success",
            message: "Choose how to install below:",
          });
        })
        .finally(() => setValidating(false));
    }, 500);
  }, []);

  const handleCopy = () => {
    if (!validId) return;
    const { addonUrl } = buildUrls(validId);
    navigator.clipboard.writeText(addonUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const urls = validId ? buildUrls(validId) : null;

  return (
    <section className="bg-gray-50 rounded-lg p-6 shadow-sm border border-gray-200">
      <div className="mb-4">
        <Label
          htmlFor="imdb-id"
          className="block text-sm font-semibold text-gray-700 mb-1"
        >
          IMDb User ID:
        </Label>
        <Input
          id="imdb-id"
          type="text"
          value={imdbId}
          onChange={(e) => handleInput(e.target.value)}
          disabled={validating}
          placeholder="ur12345678"
          className="focus-visible:ring-imdb focus-visible:border-imdb"
        />
        <p className="mt-2 text-sm text-gray-500">
          Your IMDb User ID starts with "ur" and can be found in your IMDb
          profile URL.
          <br />
          You can either enter just the ID (ur12345678) or paste your entire
          profile URL.
          <br />
          Example: https://www.imdb.com/user/ur12345678/watchlist
        </p>
      </div>

      {status && (
        <Alert
          className={`mb-4 ${
            status.type === "error"
              ? "border-red-200 bg-red-50 text-red-700"
              : status.type === "success"
                ? "border-green-200 bg-green-50 text-green-700"
                : "border-blue-200 bg-blue-50 text-blue-700"
          }`}
        >
          <AlertDescription>{status.message}</AlertDescription>
        </Alert>
      )}

      {validId && urls && (
        <div className="space-y-5">
          <div className="flex flex-col sm:flex-row gap-3">
            <Button
              asChild
              className="flex-1 bg-blue-500 hover:bg-blue-600 h-11"
            >
              <a href={urls.webUrl} target="_blank" rel="noopener noreferrer">
                Open in Stremio Web
              </a>
            </Button>
            <Button
              asChild
              className="flex-1 bg-green-500 hover:bg-green-600 h-11"
            >
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
                className="bg-imdb hover:bg-imdb-dark text-black font-semibold"
              >
                {copied ? <Check /> : <Copy />}
              </Button>
            </div>
            <p className="mt-1.5 text-xs text-gray-400">
              This URL already contains your IMDb ID and will install directly
              without configuration.
            </p>
          </div>

          <p className="text-sm text-gray-500">
            After installing, you can customize your sort order on the{" "}
            <Link
              to={`/configure?userId=${validId}`}
              className="text-stremlist underline hover:text-blue-700"
            >
              configure page
            </Link>
            .
          </p>
        </div>
      )}
    </section>
  );
}
