import { useState, useEffect, useCallback } from "react";
import {
  DEFAULT_SORT_OPTION,
  IMDB_WATCHLIST_SOURCE_ID_PATTERN,
} from "@stremlist/shared/constants";
import { CHART_REGISTRY, isChartId } from "@stremlist/shared/imdb-charts";
import type {
  UserConfigResponse,
  ConfigWatchlist,
} from "@stremlist/shared/stremio.types";
import { api } from "../lib/api";
import {
  createWatchlistRow,
  getWatchlistReinstallSignature,
} from "../lib/watchlist-form";
import type { WatchlistFormRow } from "../lib/watchlist-form";

export const MAX_WATCHLISTS = 10;

export function useWatchlistConfiguration(userId: string | null) {
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
  const [refreshing, setRefreshing] = useState(false);
  const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(null);
  const [cooldownSeconds, setCooldownSeconds] = useState(60);
  const [now, setNow] = useState(() => Date.now());
  const [userNotFound, setUserNotFound] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
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
    setLoadError(false);
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
    setLastFetchedAt(null);

    api[":userId"].config
      .$get({ param: { userId } })
      .then((res) => {
        if (res.status === 404) {
          setUserNotFound(true);
          return null;
        }
        if (!res.ok) {
          throw new Error("Failed to load configuration");
        }
        return res.json();
      })
      .then((raw) => {
        const data = raw as Partial<UserConfigResponse>;
        if (data && "rpdbApiKey" in data && data.rpdbApiKey)
          setRpdbApiKey(data.rpdbApiKey);
        if (data && "lastFetchedAt" in data && data.lastFetchedAt)
          setLastFetchedAt(data.lastFetchedAt);
        if (data && typeof data.cooldownSeconds === "number")
          setCooldownSeconds(data.cooldownSeconds);
        if (data && "watchlists" in data && Array.isArray(data.watchlists)) {
          const rows = data.watchlists.map(createWatchlistRow);
          if (rows.length > 0) {
            setWatchlists(rows);
            setWatchlistBaselineSignature(getWatchlistReinstallSignature(rows));
          }
        }
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, [userId, loadAttempt]);

  // Tick once a second so the "last refreshed" label and the refresh cooldown
  // countdown stay live without per-event timers.
  useEffect(() => {
    if (!userId) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [userId]);

  const nextRefreshAt = lastFetchedAt
    ? new Date(lastFetchedAt).getTime() + cooldownSeconds * 1000
    : 0;
  const cooldownRemaining = Math.max(
    0,
    Math.ceil((nextRefreshAt - now) / 1000),
  );
  const onCooldown = cooldownRemaining > 0;

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
    setWatchlists((current) =>
      current.length >= MAX_WATCHLISTS
        ? current
        : [...current, createWatchlistRow()],
    );
  }, []);

  const addChartWatchlist = useCallback((chartId: string) => {
    const entry = CHART_REGISTRY.find((c) => c.id === chartId);
    if (!entry) return;
    setWatchlists((current) => {
      if (current.length >= MAX_WATCHLISTS) return current;
      // A chart can only be added once — its id is the uniqueness key.
      if (current.some((w) => w.imdbUserId === entry.id)) return current;
      return [
        ...current,
        createWatchlistRow({
          imdbUserId: entry.id,
          catalogTitle: entry.label,
          sortOption: DEFAULT_SORT_OPTION,
          displayMode: entry.defaultDisplayMode,
        }),
      ];
    });
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
      return "Add at least one catalog.";
    }
    if (watchlists.length > MAX_WATCHLISTS) {
      return `You can have at most ${MAX_WATCHLISTS} catalogs.`;
    }
    const seenImdbIds = new Set<string>();
    for (const watchlist of watchlists) {
      const normalizedId = watchlist.imdbUserId.trim();
      if (
        !isChartId(normalizedId) &&
        !IMDB_WATCHLIST_SOURCE_ID_PATTERN.test(normalizedId)
      ) {
        return 'Each watchlist needs a valid IMDb User ID or List ID (e.g. "ur12345678" or "ls593621567").';
      }
      if (seenImdbIds.has(normalizedId)) {
        return "IMDb IDs must be unique across catalogs.";
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
            displayMode: watchlist.displayMode,
            position: index,
            catalogSettings: watchlist.catalogSettings,
          })),
        },
      });

      const saved = (await res.json()) as {
        ok: boolean;
        error?: string;
        watchlists?: ConfigWatchlist[];
      };

      if (!res.ok) {
        throw new Error(saved.error ?? "Failed to save");
      }

      const savedRows = saved.watchlists;
      if (savedRows) {
        setWatchlists((current) =>
          current.map((row, index) => {
            const serverRow = savedRows[index];
            return serverRow
              ? {
                  ...row,
                  id: serverRow.id,
                  imdbUserId: serverRow.imdbUserId,
                  availableGenres: serverRow.availableGenres ?? [],
                }
              : row;
          }),
        );
      }

      setShowReinstallHint(requiresReinstall);
      setWatchlistBaselineSignature(currentWatchlistSignature);
      setStatus({
        type: "success",
        message: requiresReinstall
          ? "Saved! Catalog structure changed. Reinstall the addon in Stremio to refresh catalogs."
          : "Saved! Your catalogs will be refreshed with the new settings.",
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

  const handleRefresh = async () => {
    if (!userId || refreshing || onCooldown) return;

    setRefreshing(true);
    setStatus(null);

    try {
      const res = await api[":userId"].refresh.$post({ param: { userId } });
      const json = (await res.json()) as {
        ok: boolean;
        error?: string;
        lastFetchedAt?: string;
        watchlists?: ConfigWatchlist[];
        refreshed?: number;
        failed?: number;
        total?: number;
        throttled?: boolean;
        cooldownSeconds?: number;
      };

      if (!res.ok) {
        throw new Error(json.error ?? "Failed to refresh");
      }

      if (typeof json.cooldownSeconds === "number")
        setCooldownSeconds(json.cooldownSeconds);
      if (json.lastFetchedAt) setLastFetchedAt(json.lastFetchedAt);
      if (json.watchlists) {
        const refreshedRows = json.watchlists;
        setWatchlists((current) =>
          current.map((row) => {
            const refreshedRow = refreshedRows.find(
              (saved) =>
                saved.id === row.id && saved.imdbUserId === row.imdbUserId,
            );
            return refreshedRow
              ? { ...row, availableGenres: refreshedRow.availableGenres ?? [] }
              : row;
          }),
        );
      }

      // Success feedback is the live "Last refreshed" label + cooldown countdown,
      // so only surface a message when some catalogs actually failed to refresh.
      if (json.failed && json.failed > 0) {
        setStatus({
          type: "error",
          message: `Refreshed ${json.refreshed ?? 0} of ${json.total ?? 0} catalogs — some failed to update.`,
        });
      }
    } catch (err) {
      setStatus({
        type: "error",
        message: err instanceof Error ? err.message : "Something went wrong",
      });
    } finally {
      setRefreshing(false);
    }
  };

  const retryLoad = () => setLoadAttempt((current) => current + 1);
  const reorderWatchlists = (initialIndex: number, index: number) => {
    setWatchlists((items) => {
      const allDefaultTitles = items.every((w, i) => {
        const t = w.catalogTitle.trim();
        return t === "" || t === String(i + 1);
      });
      const reordered = [...items];
      const [removed] = reordered.splice(initialIndex, 1);
      reordered.splice(index, 0, removed);
      if (allDefaultTitles) {
        return reordered.map((w) => ({
          ...w,
          catalogTitle: "",
        }));
      }
      return reordered;
    });
  };

  return {
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
  };
}
