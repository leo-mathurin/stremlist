import { useId } from "react";
import type { PosterSource } from "@stremlist/shared/poster";
import { cn } from "@/lib/utils";

const OPTIONS: { value: PosterSource; label: string; hint: string }[] = [
  { value: "imdb", label: "IMDb", hint: "Default" },
  { value: "tmdb", label: "TMDB", hint: "The Movie Database" },
];

/**
 * Where the posters of the Account come from. An RPDB key replaces both
 * sources, so the page says so when a key is set.
 */
export default function PosterSourceSettings({
  value,
  onChange,
  rpdbKeySet,
}: {
  value: PosterSource;
  onChange: (source: PosterSource) => void;
  rpdbKeySet: boolean;
}) {
  const id = useId();
  const descriptionId = `${id}-description`;
  const noteId = `${id}-note`;

  return (
    <fieldset aria-describedby={`${descriptionId} ${noteId}`}>
      <legend className="font-bold">Poster source</legend>
      <p id={descriptionId} className="mt-0.5 mb-3 text-sm text-black/55">
        Where Stremlist gets the posters of your catalogs. Posters from both
        sources can show logos of streaming services.
      </p>
      <div className="grid grid-cols-2 gap-1 rounded-2xl bg-black/5 p-1">
        {OPTIONS.map((option) => (
          <label
            key={option.value}
            className={cn(
              "relative flex min-h-11 cursor-pointer flex-col justify-center rounded-xl px-3 py-2 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand/60",
              value === option.value
                ? "bg-white font-semibold shadow-sm"
                : "text-black/60 hover:text-ink",
            )}
          >
            <input
              type="radio"
              name={`${id}-source`}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="absolute inset-0 cursor-pointer appearance-none rounded-xl opacity-0"
            />
            <span>{option.label}</span>
            <span className="text-xs font-normal text-black/45">
              {option.hint}
            </span>
          </label>
        ))}
      </div>
      <p id={noteId} className="mt-2 text-xs text-pretty text-black/55">
        {rpdbKeySet
          ? "Your RPDB key is set, so RPDB posters replace this choice."
          : value === "tmdb"
            ? "When TMDB has no poster for a title, or does not answer, Stremlist shows the IMDb poster."
            : "Stremlist uses IMDb posters, as before."}
      </p>
    </fieldset>
  );
}
