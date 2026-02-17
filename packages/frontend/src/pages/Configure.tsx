import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams, Link } from "react-router";
import { SORT_OPTIONS, DEFAULT_SORT_OPTION } from "@stremlist/shared";
import Header from "../components/Header";
import { api } from "../lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

function extractImdbId(text: string): string {
  if (!text) return "";
  const match = text.match(/ur\d+/);
  return match ? match[0] : "";
}

export default function Configure() {
  const [searchParams, setSearchParams] = useSearchParams();
  const userId = searchParams.get("userId");

  const [idInput, setIdInput] = useState("");
  const [idError, setIdError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const [sortOption, setSortOption] = useState(DEFAULT_SORT_OPTION);
  const [loading, setLoading] = useState(!!userId);
  const [saving, setSaving] = useState(false);
  const [userNotFound, setUserNotFound] = useState(false);
  const [status, setStatus] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  useEffect(() => {
    if (!userId) return;

    setLoading(true);
    setUserNotFound(false);
    setSortOption(DEFAULT_SORT_OPTION);
    setStatus(null);

    api[":userId"].config
      .$get({ param: { userId } })
      .then((res) => {
        if (res.status === 404) {
          setUserNotFound(true);
          return null;
        }
        return res.json();
      })
      .then((data) => {
        if (data && "sortOption" in data && data.sortOption)
          setSortOption(data.sortOption);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [userId]);

  const handleIdInput = useCallback(
    (value: string) => {
      setIdInput(value);
      setIdError(null);

      if (debounceRef.current) clearTimeout(debounceRef.current);

      const trimmed = value.trim();
      if (!trimmed) return;

      debounceRef.current = setTimeout(() => {
        const extracted = extractImdbId(trimmed);

        if (!extracted || extracted.length <= 3) {
          setIdError(
            'Enter a valid IMDb ID starting with "ur" (e.g., ur12345678)',
          );
          return;
        }

        setValidating(true);
        setIdError(null);
        api.validate[":userId"]
          .$get({ param: { userId: extracted } })
          .then((res) => res.json())
          .then((data) => {
            if (data.valid) {
              setSearchParams({ userId: extracted });
            } else {
              setIdError(
                "This IMDb ID does not exist. Please check and try again.",
              );
            }
          })
          .catch(() => {
            setSearchParams({ userId: extracted });
          })
          .finally(() => setValidating(false));
      }, 500);
    },
    [setSearchParams],
  );

  const handleSave = async () => {
    if (!userId) return;

    setSaving(true);
    setStatus(null);

    try {
      const res = await api[":userId"].config.$post({
        param: { userId },
        json: { sortOption },
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? "Failed to save");
      }

      setStatus({
        type: "success",
        message:
          "Saved! Your watchlist will be refreshed with the new sort order.",
      });
    } catch (err) {
      setStatus({
        type: "error",
        message: err instanceof Error ? err.message : "Something went wrong",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto my-8 bg-white rounded-lg shadow-md p-8">
      <Header />

      <main>
        <Button
          variant="link"
          asChild
          className="h-auto p-0 text-stremlist text-sm"
        >
          <Link to="/">&larr; Back to Home</Link>
        </Button>

        <h2 className="text-xl font-bold text-gray-900 mt-4 mb-1">Configure</h2>

        {!userId ? (
          <section className="bg-gray-50 rounded-lg p-6 border border-gray-200 mt-4">
            <Label
              htmlFor="imdb-id"
              className="block text-sm font-semibold text-gray-700 mb-1"
            >
              IMDb User ID:
            </Label>
            <Input
              id="imdb-id"
              type="text"
              value={idInput}
              onChange={(e) => handleIdInput(e.target.value)}
              disabled={validating}
              placeholder="ur12345678"
              className="focus-visible:ring-imdb focus-visible:border-imdb"
            />
            <p className="mt-2 text-sm text-gray-500">
              Enter your IMDb User ID to configure your addon settings.
            </p>
            {validating && (
              <p className="mt-2 text-sm text-blue-600">
                Validating IMDb ID...
              </p>
            )}
            {idError && (
              <Alert className="mt-2 border-red-200 bg-red-50 text-red-600">
                <AlertDescription>{idError}</AlertDescription>
              </Alert>
            )}
          </section>
        ) : (
          <>
            <p className="text-sm text-gray-500 mb-6">
              Settings for <strong>{userId}</strong>
            </p>

            <section className="bg-gray-50 rounded-lg p-6 border border-gray-200">
              {loading ? (
                <p className="text-sm text-gray-400">Loading...</p>
              ) : userNotFound ? (
                <Alert className="border-red-200 bg-red-50 text-red-700">
                  <AlertDescription>
                    User not found. Please{" "}
                    <Link to="/" className="underline font-semibold">
                      install the addon
                    </Link>{" "}
                    first before configuring.
                  </AlertDescription>
                </Alert>
              ) : (
                <>
                  <Label
                    htmlFor="sort"
                    className="block text-sm font-semibold text-gray-700 mb-2"
                  >
                    Sort Watchlist By
                  </Label>
                  <Select value={sortOption} onValueChange={setSortOption}>
                    <SelectTrigger
                      id="sort"
                      className="w-full focus:ring-imdb focus:border-imdb"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SORT_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <Button
                    onClick={handleSave}
                    disabled={saving}
                    className="w-full mt-4 h-11 bg-imdb hover:bg-imdb-dark text-black font-semibold"
                  >
                    {saving ? "Saving..." : "Save"}
                  </Button>

                  {status && (
                    <Alert
                      className={`mt-4 text-center ${
                        status.type === "success"
                          ? "border-green-200 bg-green-50 text-green-700"
                          : "border-red-200 bg-red-50 text-red-700"
                      }`}
                    >
                      <AlertDescription>{status.message}</AlertDescription>
                    </Alert>
                  )}
                </>
              )}
            </section>
          </>
        )}
      </main>

      <footer className="mt-8 pt-6 border-t border-gray-200 text-center text-sm text-gray-500 space-y-2">
        <p>
          <Button variant="link" asChild className="h-auto p-0 text-stremlist">
            <Link to="/">Return to Home</Link>
          </Button>
        </p>
        <p>&copy; 2025 - IMDb Watchlist for Stremio</p>
      </footer>
    </div>
  );
}
