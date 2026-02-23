import { useState, useRef, useCallback, useEffect } from "react";
import { Link } from "react-router";
import { ArrowRight } from "lucide-react";
import { api } from "../lib/api";
import AddonInstallActions from "./AddonInstallActions";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

function extractImdbId(text: string): string {
  if (!text) return "";
  const match = text.match(/ur\d+/);
  return match ? match[0] : "";
}

function getInitialUserId(): string {
  const params = new URLSearchParams(window.location.search);
  const userId = params.get("userId") ?? "";
  const extracted = extractImdbId(userId);
  return extracted.length > 3 ? extracted : "";
}

function setUserIdQueryParam(userId: string): void {
  const url = new URL(window.location.href);
  if (userId) {
    url.searchParams.set("userId", userId);
  } else {
    url.searchParams.delete("userId");
  }

  window.history.replaceState(window.history.state, "", url.toString());
}

type Status = { type: "error" | "success" | "info"; message: string } | null;

function getValidationErrorMessage(data: { valid: boolean; reason?: string }): string {
  if ("reason" in data && data.reason === "private") {
    return "This IMDb watchlist is private. Please make your watchlist public in your IMDb settings.";
  }
  return "This IMDb ID does not exist. Please check and try again.";
}

async function checkExistingUser(
  userId: string,
): Promise<boolean> {
  try {
    const res = await api[":userId"].config.$get({
      param: { userId },
    });
    return res.status !== 404;
  } catch {
    return false;
  }
}

export default function SetupForm() {
  const initialUserId = getInitialUserId();
  const [imdbId, setImdbId] = useState(initialUserId);
  const [validId, setValidId] = useState<string | null>(null);
  const [isReturningUser, setIsReturningUser] = useState(false);
  const [status, setStatus] = useState<Status>(
    initialUserId ? { type: "info", message: "Validating IMDb ID..." } : null,
  );
  const [validating, setValidating] = useState(Boolean(initialUserId));
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!initialUserId) return;

    (async () => {
      try {
        const exists = await checkExistingUser(initialUserId);
        if (exists) {
          setValidId(initialUserId);
          setIsReturningUser(true);
          setUserIdQueryParam(initialUserId);
          setStatus({
            type: "success",
            message: `Welcome back, ${initialUserId}!`,
          });
        } else {
          const res = await api.validate[":userId"].$get({
            param: { userId: initialUserId },
          });
          const data = await res.json();
          if (data.valid) {
            setValidId(initialUserId);
            setUserIdQueryParam(initialUserId);
            setStatus({
              type: "success",
              message: "Choose how to install below:",
            });
          } else {
            setStatus({ type: "error", message: getValidationErrorMessage(data) });
          }
        }
      } catch {
        setStatus({
          type: "error",
          message: "Could not validate this IMDb ID. Please try again later.",
        });
      } finally {
        setValidating(false);
      }
    })();
  }, [initialUserId]);

  const handleInput = useCallback((value: string) => {
    setImdbId(value);
    setValidId(null);
    setIsReturningUser(false);
    setStatus(null);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    const trimmed = value.trim();
    if (!trimmed) {
      setUserIdQueryParam("");
      return;
    }

    debounceRef.current = setTimeout(async () => {
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

      try {
        const exists = await checkExistingUser(extracted);
        if (exists) {
          setValidId(extracted);
          setIsReturningUser(true);
          setUserIdQueryParam(extracted);
          setStatus({
            type: "success",
            message: `Welcome back, ${extracted}!`,
          });
          return;
        }

        const res = await api.validate[":userId"].$get({
          param: { userId: extracted },
        });
        const data = await res.json();
        if (data.valid) {
          setValidId(extracted);
          setUserIdQueryParam(extracted);
          setStatus({
            type: "success",
            message: "Choose how to install below:",
          });
        } else {
          setStatus({ type: "error", message: getValidationErrorMessage(data) });
        }
      } catch {
        setStatus({
          type: "error",
          message: "Could not validate this IMDb ID. Please try again later.",
        });
      } finally {
        setValidating(false);
      }
    }, 500);
  }, []);

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

      {validId && isReturningUser && (
        <div className="space-y-4">
          <Button
            asChild
            className="w-full h-12 bg-imdb hover:bg-imdb-dark text-black gap-2"
          >
            <Link to={`/configure?userId=${validId}`}>
              Configure your Stremlist
              <ArrowRight className="size-5" />
            </Link>
          </Button>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t border-gray-300" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-gray-50 px-2 text-gray-400">
                or reinstall
              </span>
            </div>
          </div>

          <AddonInstallActions imdbUserId={validId} />
        </div>
      )}

      {validId && !isReturningUser && (
        <div className="space-y-5">
          <AddonInstallActions imdbUserId={validId} />
          <p className="mt-1.5 text-xs text-gray-400">
            This URL already contains your IMDb ID and will install directly
            without configuration.
          </p>

          <p className="text-sm text-gray-500">
            After installing, you can add multiple watchlists, change sort
            order, enable RPDB posters, and more on the{" "}
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
