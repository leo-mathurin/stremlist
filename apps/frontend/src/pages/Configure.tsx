import { useState, useCallback, useRef } from "react";
import { useSearchParams, Link } from "react-router";
import { IMDB_USER_ID_EXTRACT_PATTERN } from "@stremlist/shared/constants";
import { Eye, EyeOff, Plus, RefreshCw } from "lucide-react";
import { DragDropProvider } from "@dnd-kit/react";
import { isSortable } from "@dnd-kit/react/sortable";
import SortableWatchlistRow from "../components/SortableWatchlistRow";
import Header from "../components/Header";
import AddonInstallActions from "../components/AddonInstallActions";
import BuiltInCatalogPicker from "../components/BuiltInCatalogPicker";
import { api } from "../lib/api";
import { useSEO } from "../hooks/useSEO";
import {
  MAX_WATCHLISTS,
  useWatchlistConfiguration,
} from "../hooks/useWatchlistConfiguration";
import { cn, formatRelativeTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";

function extractImdbId(text: string): string {
  if (!text) return "";
  const match = text.match(IMDB_USER_ID_EXTRACT_PATTERN);
  return match ? match[0] : "";
}

export default function Configure() {
  useSEO({
    title: "Configure - Stremlist",
    description:
      "Configure your Stremlist addon settings, watchlists, lists, and sorting preferences.",
    robots: "noindex, nofollow",
  });

  const [searchParams, setSearchParams] = useSearchParams();
  const userId = searchParams.get("userId");
  const homePath = userId ? `/?userId=${encodeURIComponent(userId)}` : "/";

  const [idInput, setIdInput] = useState("");
  const [idError, setIdError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const {
    watchlists,
    setWatchlistField,
    removeWatchlist,
    addWatchlist,
    addChartWatchlist,
    rpdbApiKey,
    setRpdbApiKey,
    showRpdbApiKey,
    setShowRpdbApiKey,
    loading,
    saving,
    refreshing,
    lastFetchedAt,
    cooldownRemaining,
    onCooldown,
    userNotFound,
    loadError,
    showReinstallHint,
    status,
    validationError,
    handleSave,
    handleRefresh,
    reorderWatchlists,
    retryLoad,
  } = useWatchlistConfiguration(userId);

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
            'Enter a valid IMDb ID starting with "ur" (e.g., ur12345678) or "p." (e.g., p.colneedham)',
          );
          return;
        }

        setValidating(true);
        setIdError(null);
        (async () => {
          try {
            const res = await api.validate[":userId"].$get({
              param: { userId: extracted },
            });
            const data = await res.json();
            if (data.valid) {
              const canonicalId = "userId" in data ? data.userId : extracted;
              setSearchParams({ userId: canonicalId });
            } else {
              const reason = "reason" in data ? data.reason : undefined;
              setIdError(
                reason === "private"
                  ? "This IMDb watchlist is private. Please make your watchlist public in your IMDb settings."
                  : "This IMDb ID does not exist. Please check and try again.",
              );
            }
          } catch {
            setIdError(
              "Could not validate this IMDb ID. Please try again later.",
            );
          } finally {
            setValidating(false);
          }
        })();
      }, 500);
    },
    [setSearchParams],
  );

  return (
    <div className="max-w-3xl mx-auto my-8 bg-white rounded-lg shadow-md p-8">
      <Header />

      <main>
        <Button
          variant="link"
          asChild
          className="h-auto p-0 text-stremlist text-sm"
        >
          <Link to={homePath}>&larr; Back to Home</Link>
        </Button>

        <div className="mt-4 mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="space-y-1">
            <h2 className="text-xl font-bold text-gray-900">Configure</h2>
            {userId && !userNotFound && (
              <p className="text-sm text-gray-500">
                Settings for{" "}
                <strong className="font-semibold text-gray-700">
                  {userId}
                </strong>
              </p>
            )}
          </div>
          {userId && !loading && !userNotFound && !loadError && (
            <div className="flex items-center gap-3">
              <p className="flex items-center gap-2 text-sm text-gray-500">
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    refreshing
                      ? "animate-pulse bg-amber-400"
                      : lastFetchedAt
                        ? "bg-emerald-500"
                        : "bg-gray-300",
                  )}
                  aria-hidden="true"
                />
                <span>
                  Last refreshed{" "}
                  <span className="font-semibold text-gray-900">
                    {formatRelativeTime(lastFetchedAt)}
                  </span>
                </span>
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleRefresh}
                disabled={refreshing || onCooldown}
                className="gap-2 tabular-nums"
              >
                <RefreshCw
                  className={cn("size-4", refreshing && "animate-spin")}
                />
                {refreshing
                  ? "Refreshing…"
                  : onCooldown
                    ? `Refresh in ${cooldownRemaining}s`
                    : "Refresh now"}
              </Button>
            </div>
          )}
        </div>

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
            <section>
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
              ) : loadError ? (
                <Alert className="border-red-200 bg-red-50 text-red-700">
                  <AlertDescription className="gap-3">
                    <p>Could not load your configuration. Please try again.</p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={retryLoad}
                      className="border-red-300 bg-white text-red-700 hover:bg-red-100"
                    >
                      Try again
                    </Button>
                  </AlertDescription>
                </Alert>
              ) : (
                <>
                  <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-4">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <h3 className="text-base font-semibold text-gray-900">
                        Catalogs
                      </h3>
                      <div className="flex flex-wrap items-center gap-2">
                        <BuiltInCatalogPicker
                          usedIds={watchlists.map((w) => w.imdbUserId)}
                          disabled={watchlists.length >= MAX_WATCHLISTS}
                          onAdd={addChartWatchlist}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          onClick={addWatchlist}
                          disabled={watchlists.length >= MAX_WATCHLISTS}
                          className="gap-2"
                        >
                          <Plus className="size-4" />
                          Add Catalog
                        </Button>
                      </div>
                    </div>

                    <DragDropProvider
                      onDragEnd={(event) => {
                        if (event.canceled) return;
                        const { source } = event.operation;
                        if (isSortable(source)) {
                          const { initialIndex, index } = source;
                          if (initialIndex !== index) {
                            reorderWatchlists(initialIndex, index);
                          }
                        }
                      }}
                    >
                      <div className="space-y-3">
                        {watchlists.map((watchlist, index) => (
                          <SortableWatchlistRow
                            key={watchlist.localId}
                            watchlist={watchlist}
                            index={index}
                            onFieldChange={setWatchlistField}
                            onRemove={removeWatchlist}
                            canRemove={watchlists.length > 1}
                          />
                        ))}
                      </div>
                    </DragDropProvider>
                  </div>

                  {validationError && (
                    <Alert className="mt-4 border-red-200 bg-red-50 text-red-700">
                      <AlertDescription>{validationError}</AlertDescription>
                    </Alert>
                  )}

                  <Label
                    htmlFor="rpdb-api-key"
                    className="block text-sm font-semibold text-gray-700 mt-4 mb-2"
                  >
                    RPDB API Key (Optional)
                  </Label>
                  <div className="relative">
                    <Input
                      id="rpdb-api-key"
                      type={showRpdbApiKey ? "text" : "password"}
                      value={rpdbApiKey}
                      onChange={(e) => setRpdbApiKey(e.target.value)}
                      placeholder="Paste your RPDB API key"
                      className="pr-10 focus-visible:ring-imdb focus-visible:border-imdb"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => setShowRpdbApiKey((current) => !current)}
                      aria-label={
                        showRpdbApiKey
                          ? "Hide RPDB API key"
                          : "Show RPDB API key"
                      }
                      className="absolute right-1 top-1/2 size-7 -translate-y-1/2 text-gray-500 hover:text-gray-700"
                    >
                      {showRpdbApiKey ? <EyeOff /> : <Eye />}
                    </Button>
                  </div>
                  <p className="mt-2 text-xs text-gray-500">
                    Enables Rating Poster Database posters for this addon
                    installation.
                  </p>

                  <Button
                    onClick={handleSave}
                    disabled={saving || !!validationError}
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

                  {userId && (
                    <div
                      className={`mt-4 rounded-lg p-4 ${
                        showReinstallHint
                          ? "border border-amber-200 bg-amber-50"
                          : "border border-gray-200 bg-white"
                      }`}
                    >
                      <p
                        className={`text-sm font-semibold ${
                          showReinstallHint ? "text-amber-900" : "text-gray-900"
                        }`}
                      >
                        {showReinstallHint
                          ? "Catalog structure changed: reinstall required in Stremio"
                          : "Install / Reinstall Addon in Stremio"}
                      </p>
                      <p
                        className={`mt-1 text-xs ${
                          showReinstallHint ? "text-amber-800" : "text-gray-600"
                        }`}
                      >
                        {showReinstallHint
                          ? "Stremio only reads manifest catalogs at install time, so modifications to catalogs will appear after reinstalling this addon URL."
                          : "Use these install links anytime to reopen or reinstall the addon URL in Stremio."}
                      </p>
                      <AddonInstallActions
                        imdbUserId={userId}
                        className="mt-3 space-y-4"
                      />
                    </div>
                  )}
                </>
              )}
            </section>
          </>
        )}
      </main>

      <footer className="pt-6 text-center text-sm text-gray-500 space-y-2">
        <p>
          <Button variant="link" asChild className="h-auto p-0 text-stremlist">
            <Link to={homePath}>Return to Home</Link>
          </Button>
        </p>
        <p>&copy; 2025 - IMDb Watchlist for Stremio</p>
      </footer>
    </div>
  );
}
