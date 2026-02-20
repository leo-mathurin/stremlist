import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams, Link } from "react-router";
import { SORT_OPTIONS, DEFAULT_SORT_OPTION } from "@stremlist/shared";
import type { UserConfigResponse } from "@stremlist/shared";
import { Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import Header from "../components/Header";
import AddonInstallActions from "../components/AddonInstallActions";
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

type WatchlistFormRow = {
  id?: string;
  localId: string;
  imdbUserId: string;
  catalogTitle: string;
  sortOption: string;
};

function getWatchlistReinstallSignature(rows: WatchlistFormRow[]): string {
  return rows
    .map((row, index) => ({
      index,
      id: row.id ?? row.localId,
      imdbUserId: row.imdbUserId.trim(),
      catalogTitle: row.catalogTitle.trim(),
    }))
    .map(
      (item) =>
        `${item.index}|${item.id}|${item.imdbUserId}|${item.catalogTitle}`,
    )
    .join("::");
}

function createWatchlistRow(
  partial?: Partial<Omit<WatchlistFormRow, "localId">>,
): WatchlistFormRow {
  return {
    id: partial?.id,
    localId: crypto.randomUUID(),
    imdbUserId: partial?.imdbUserId ?? "",
    catalogTitle: partial?.catalogTitle ?? "",
    sortOption: partial?.sortOption ?? DEFAULT_SORT_OPTION,
  };
}

export default function Configure() {
  const [searchParams, setSearchParams] = useSearchParams();
  const userId = searchParams.get("userId");

  const [idInput, setIdInput] = useState("");
  const [idError, setIdError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const [watchlists, setWatchlists] = useState<WatchlistFormRow[]>([
    createWatchlistRow({
      imdbUserId: userId ?? "",
      catalogTitle: "",
      sortOption: DEFAULT_SORT_OPTION,
    }),
  ]);
  const [rpdbApiKey, setRpdbApiKey] = useState("");
  const [showRpdbApiKey, setShowRpdbApiKey] = useState(false);
  const [loading, setLoading] = useState(!!userId);
  const [saving, setSaving] = useState(false);
  const [userNotFound, setUserNotFound] = useState(false);
  const [showReinstallHint, setShowReinstallHint] = useState(false);
  const [watchlistBaselineSignature, setWatchlistBaselineSignature] =
    useState("");
  const [status, setStatus] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  useEffect(() => {
    if (!userId) return;

    setLoading(true);
    setUserNotFound(false);
    setWatchlists([
      createWatchlistRow({
        imdbUserId: userId,
        catalogTitle: "",
        sortOption: DEFAULT_SORT_OPTION,
      }),
    ]);
    setRpdbApiKey("");
    setShowRpdbApiKey(false);
    setStatus(null);
    setShowReinstallHint(false);
    setWatchlistBaselineSignature("");

    api[":userId"].config
      .$get({ param: { userId } })
      .then((res) => {
        if (res.status === 404) {
          setUserNotFound(true);
          return null;
        }
        return res.json();
      })
      .then((raw) => {
        const data = raw as Partial<UserConfigResponse>;
        if (data && "rpdbApiKey" in data && data.rpdbApiKey)
          setRpdbApiKey(data.rpdbApiKey);
        if (data && "watchlists" in data && Array.isArray(data.watchlists)) {
          const rows = data.watchlists.map((watchlist) =>
            createWatchlistRow({
              id: watchlist.id,
              imdbUserId: watchlist.imdbUserId,
              catalogTitle: watchlist.catalogTitle,
              sortOption: watchlist.sortOption,
            }),
          );
          if (rows.length > 0) {
            setWatchlists(rows);
            setWatchlistBaselineSignature(getWatchlistReinstallSignature(rows));
          }
        }
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

  const setWatchlistField = useCallback(
    <K extends keyof WatchlistFormRow>(
      localId: string,
      key: K,
      value: WatchlistFormRow[K],
    ) => {
      setWatchlists((current) =>
        current.map((watchlist) =>
          watchlist.localId === localId
            ? { ...watchlist, [key]: value }
            : watchlist,
        ),
      );
    },
    [],
  );

  const addWatchlist = useCallback(() => {
    setWatchlists((current) => [...current, createWatchlistRow()]);
  }, []);

  const removeWatchlist = useCallback((localId: string) => {
    setWatchlists((current) => {
      if (current.length <= 1) {
        return current;
      }
      return current.filter((watchlist) => watchlist.localId !== localId);
    });
  }, []);

  const validationError = (() => {
    if (watchlists.length === 0) {
      return "Add at least one watchlist.";
    }
    const seenImdbIds = new Set<string>();
    for (const watchlist of watchlists) {
      const normalizedId = watchlist.imdbUserId.trim();
      if (!/^ur\d{4,}$/.test(normalizedId)) {
        return 'Each watchlist needs a valid IMDb User ID (e.g. "ur12345678").';
      }
      if (seenImdbIds.has(normalizedId)) {
        return "IMDb User IDs must be unique across watchlists.";
      }
      seenImdbIds.add(normalizedId);
    }
    return null;
  })();

  const handleSave = async () => {
    if (!userId || validationError) return;

    setSaving(true);
    setStatus(null);

    try {
      const currentWatchlistSignature =
        getWatchlistReinstallSignature(watchlists);
      const requiresReinstall =
        watchlistBaselineSignature.length === 0
          ? false
          : currentWatchlistSignature !== watchlistBaselineSignature;

      const res = await api[":userId"].config.$post({
        param: { userId },
        json: {
          rpdbApiKey,
          watchlists: watchlists.map((watchlist, index) => ({
            id: watchlist.id,
            imdbUserId: watchlist.imdbUserId.trim(),
            catalogTitle: watchlist.catalogTitle.trim(),
            sortOption: watchlist.sortOption,
            position: index,
          })),
        },
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? "Failed to save");
      }

      setShowReinstallHint(requiresReinstall);
      setWatchlistBaselineSignature(currentWatchlistSignature);
      setStatus({
        type: "success",
        message: requiresReinstall
          ? "Saved! Watchlist catalog structure changed. Reinstall the addon in Stremio to refresh catalogs."
          : "Saved! Your watchlist will be refreshed with the new settings.",
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
                  <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-4">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <h3 className="text-base font-semibold text-gray-900">
                        Watchlist Catalogs
                      </h3>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={addWatchlist}
                        className="gap-2"
                      >
                        <Plus className="size-4" />
                        Add Watchlist
                      </Button>
                    </div>

                    <div className="space-y-3">
                      {watchlists.map((watchlist, index) => (
                        <div
                          key={watchlist.localId}
                          className="rounded-lg border border-gray-200 bg-gray-50 p-4"
                        >
                          <div className="flex items-center justify-between mb-3">
                            <p className="text-sm font-semibold text-gray-800">
                              Watchlist {index + 1}
                            </p>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => removeWatchlist(watchlist.localId)}
                              disabled={watchlists.length <= 1}
                              className="text-gray-500 hover:text-red-600"
                              aria-label="Remove watchlist"
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </div>

                          <Label className="block text-xs font-semibold text-gray-600 mb-1">
                            IMDb User ID
                          </Label>
                          <Input
                            value={watchlist.imdbUserId}
                            onChange={(e) =>
                              setWatchlistField(
                                watchlist.localId,
                                "imdbUserId",
                                e.target.value,
                              )
                            }
                            placeholder="ur12345678"
                            className="focus-visible:ring-imdb focus-visible:border-imdb"
                          />

                          <Label className="block text-xs font-semibold text-gray-600 mt-3 mb-1">
                            Catalog Title (Optional)
                          </Label>
                          <Input
                            value={watchlist.catalogTitle}
                            onChange={(e) =>
                              setWatchlistField(
                                watchlist.localId,
                                "catalogTitle",
                                e.target.value,
                              )
                            }
                            placeholder="Tom Hardy's Watchlist"
                            className="focus-visible:ring-imdb focus-visible:border-imdb"
                          />

                          <Label className="block text-xs font-semibold text-gray-600 mt-3 mb-1">
                            Sort Order
                          </Label>
                          <Select
                            value={watchlist.sortOption}
                            onValueChange={(value) =>
                              setWatchlistField(
                                watchlist.localId,
                                "sortOption",
                                value,
                              )
                            }
                          >
                            <SelectTrigger className="w-full bg-white focus:ring-imdb focus:border-imdb">
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
                        </div>
                      ))}
                    </div>
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
                          ? "Stremio only reads manifest catalogs at install time, so modifications to watchlists will appear after reinstalling this addon URL."
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
