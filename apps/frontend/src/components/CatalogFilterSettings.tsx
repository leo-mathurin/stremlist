import {
  CATALOG_DECADES,
  CATALOG_GENRES,
  CATALOG_PRESETS,
} from "@stremlist/shared";
import type { CatalogSettings } from "@stremlist/shared";

const FILTERS = [
  ["genre", "Genre", "All genres", CATALOG_GENRES, ""],
  [
    "decade",
    "Decade",
    "All decades",
    CATALOG_DECADES.map((decade) => Number.parseInt(decade, 10)),
    "s",
  ],
  [
    "maxRuntime",
    "Maximum runtime",
    "Any length",
    [60, 90, 120, 150, 180],
    " min or less",
  ],
  [
    "minRating",
    "Minimum IMDb rating",
    "Any rating",
    [5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9],
    " and above",
  ],
] as const;

export default function CatalogFilterSettings({
  value,
  onChange,
}: {
  value: CatalogSettings;
  onChange: (settings: CatalogSettings) => void;
}) {
  const selectClass =
    "mt-1 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-imdb";
  return (
    <details className="mt-4 border-t border-gray-200 pt-3">
      <summary className="cursor-pointer text-sm font-semibold text-gray-800">
        Filters & extra catalogs
      </summary>
      <p className="mt-2 text-xs leading-relaxed text-gray-500">
        All selected filters apply together, including in search. Use Sort Order
        above to order the results.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {FILTERS.map(([key, label, empty, choices, suffix]) => {
          const current = value[key];
          const options = new Set<string | number>(choices);
          if (current !== undefined) options.add(current);
          return (
            <label key={key} className="text-xs font-semibold text-gray-600">
              {label}
              <select
                className={selectClass}
                value={current ?? ""}
                onChange={(event) =>
                  onChange({
                    ...value,
                    [key]:
                      event.target.value === ""
                        ? undefined
                        : key === "genre"
                          ? event.target.value
                          : Number(event.target.value),
                  })
                }
              >
                <option value="">{empty}</option>
                {[...options].map((option) => (
                  <option key={option} value={option}>
                    {option}
                    {suffix}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
      </div>
      <fieldset className="mt-4">
        <legend className="text-xs font-semibold text-gray-600">
          Extra catalogs on your Stremio home
        </legend>
        <p className="mt-1 text-xs text-gray-500">
          Use the same list and filters. Reinstall after changing these options.
        </p>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
          {CATALOG_PRESETS.map((preset) => (
            <label
              key={preset.id}
              className="flex items-center gap-2 text-sm text-gray-700"
            >
              <input
                type="checkbox"
                className="size-4 accent-imdb"
                checked={value.presets?.includes(preset.id) ?? false}
                onChange={(event) =>
                  onChange({
                    ...value,
                    presets: event.target.checked
                      ? [...(value.presets ?? []), preset.id]
                      : value.presets?.filter((id) => id !== preset.id),
                  })
                }
              />
              {preset.label}
            </label>
          ))}
        </div>
      </fieldset>
    </details>
  );
}
