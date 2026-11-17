import { useId, useState } from "react";
import type { PosterSource } from "@stremlist/shared/poster";
import { rpdbPosterUrl } from "@stremlist/shared/poster";
import { ChevronDown, Eye, EyeOff, Images } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const SOURCES: { value: PosterSource; label: string; hint: string }[] = [
  { value: "imdb", label: "IMDb", hint: "The posters Stremlist always used." },
  {
    value: "tmdb",
    label: "TMDB",
    hint: "Posters from The Movie Database. When TMDB has none, the IMDb poster shows.",
  },
  {
    value: "rpdb",
    label: "RPDB",
    hint: "Rating Poster Database: posters with ratings on the cover art. Needs your RPDB API key.",
  },
];

/** The same three Titles from IMDb and TMDB, to compare the sources. */
const EXAMPLES = [
  {
    id: "tt1190634",
    name: "The Boys",
    imdb: "https://m.media-amazon.com/images/M/MV5BZjU4OWNiYzQtMzc1NS00NjZlLTgyYTctZWY4ZmEzMTkxYjA4XkEyXkFqcGc@._V1_QL75_UX240_.jpg",
    tmdb: "https://image.tmdb.org/t/p/w342/in1R2dDc421JxsoRWaIIAqVI2KE.jpg",
  },
  {
    id: "tt15398776",
    name: "Oppenheimer",
    imdb: "https://m.media-amazon.com/images/M/MV5BN2JkMDc5MGQtZjg3YS00NmFiLWIyZmQtZTJmNTM5MjVmYTQ4XkEyXkFqcGc@._V1_QL75_UX240_.jpg",
    tmdb: "https://image.tmdb.org/t/p/w342/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg",
  },
  {
    id: "tt0111161",
    name: "The Shawshank Redemption",
    imdb: "https://m.media-amazon.com/images/M/MV5BMDAyY2FhYjctNDc5OS00MDNlLThiMGUtY2UxYWVkNGY2ZjljXkEyXkFqcGc@._V1_QL75_UX240_.jpg",
    tmdb: "https://image.tmdb.org/t/p/w342/9cqNxx0GxF0bflZmeSMuL5tnGzr.jpg",
  },
];

/** Example posters of `source`; RPDB ones need the key. */
function Examples({
  source,
  rpdbApiKey,
}: {
  source: PosterSource;
  rpdbApiKey: string;
}) {
  if (source === "rpdb" && !rpdbApiKey.trim()) {
    return (
      <p className="text-xs text-black/55">
        Add your RPDB API key to see examples.
      </p>
    );
  }
  return (
    <ul className="flex gap-2" aria-label="Example posters">
      {EXAMPLES.map((example) => (
        <li key={example.id}>
          <img
            src={
              source === "rpdb"
                ? rpdbPosterUrl(rpdbApiKey, example.id)
                : example[source]
            }
            alt={`${example.name}, example poster`}
            loading="lazy"
            decoding="async"
            className="aspect-[2/3] w-[4.5rem] rounded-lg bg-black/5 object-cover ring-1 ring-black/5 sm:w-20"
          />
        </li>
      ))}
    </ul>
  );
}

/**
 * Where the posters of the Account come from: one choice between IMDb,
 * TMDB and RPDB. The RPDB key field shows only for RPDB; a key stays saved
 * when another source is chosen. Example posters open on request, so their
 * images load only then.
 */
export default function PosterSourceSettings({
  value,
  onChange,
  rpdbApiKey,
  onRpdbApiKeyChange,
}: {
  value: PosterSource;
  onChange: (source: PosterSource) => void;
  rpdbApiKey: string;
  onRpdbApiKeyChange: (key: string) => void;
}) {
  const selectId = useId();
  const examplesId = useId();
  const [examplesOpen, setExamplesOpen] = useState(false);
  // Images load on the first open only; after it, closing animates too.
  const [examplesShown, setExamplesShown] = useState(false);
  const [keyShown, setKeyShown] = useState(false);
  const current = SOURCES.find((source) => source.value === value);

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor={selectId} className="block font-bold">
          Posters
        </label>
        <p className="mt-0.5 mb-3 text-sm text-black/55">
          Where Stremlist gets the posters of your catalogs. Posters from any
          source can show logos of streaming services.
        </p>
        <Select
          value={value}
          onValueChange={(next) => {
            const source = SOURCES.find((option) => option.value === next);
            if (source) onChange(source.value);
          }}
        >
          <SelectTrigger
            id={selectId}
            className="h-11 w-full rounded-2xl bg-white"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SOURCES.map((source) => (
              <SelectItem key={source.value} value={source.value}>
                {source.label}
                {source.value === "imdb" && (
                  <span className="ml-1 text-black/45">(default)</span>
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="mt-1.5 flex items-center justify-between gap-3">
          <p className="text-xs text-pretty text-black/55">{current?.hint}</p>
          <button
            type="button"
            aria-expanded={examplesOpen}
            aria-controls={examplesId}
            onClick={() => {
              setExamplesOpen((open) => !open);
              setExamplesShown(true);
            }}
            className="flex min-h-8 shrink-0 items-center gap-1 rounded-full bg-black/5 px-2.5 text-xs font-semibold text-black/70 transition-colors hover:bg-black/10 focus-visible:ring-2 focus-visible:ring-brand/60 focus-visible:outline-none"
          >
            <Images aria-hidden className="size-3.5" />
            Examples
            <ChevronDown
              aria-hidden
              className={cn(
                "size-3.5 text-black/45 transition-transform duration-200 ease-out motion-reduce:transition-none",
                examplesOpen && "rotate-180",
              )}
            />
          </button>
        </div>
        <div
          id={examplesId}
          inert={!examplesOpen}
          className={cn(
            "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
            examplesOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
          )}
        >
          <div className="min-h-0 overflow-hidden">
            {examplesShown && (
              <div className="mt-3 rounded-2xl bg-black/[0.03] p-3">
                <Examples source={value} rpdbApiKey={rpdbApiKey} />
              </div>
            )}
          </div>
        </div>
      </div>

      {value === "rpdb" && (
        <div>
          <label htmlFor="rpdb-api-key" className="block text-sm font-semibold">
            RPDB API key
          </label>
          <div className="mt-1 flex items-center gap-1 rounded-2xl bg-black/5 p-1">
            <input
              id="rpdb-api-key"
              type={keyShown ? "text" : "password"}
              value={rpdbApiKey}
              onChange={(event) => onRpdbApiKeyChange(event.target.value)}
              placeholder="Paste your RPDB API key"
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm outline-none"
            />
            <button
              type="button"
              onClick={() => setKeyShown((shown) => !shown)}
              aria-label={keyShown ? "Hide RPDB API key" : "Show RPDB API key"}
              className="flex size-9 shrink-0 items-center justify-center rounded-xl text-black/50 transition-colors hover:bg-white hover:text-ink"
            >
              {keyShown ? (
                <EyeOff className="size-4" />
              ) : (
                <Eye className="size-4" />
              )}
            </button>
          </div>
          <p className="mt-1.5 text-xs text-pretty text-black/55">
            {rpdbApiKey.trim()
              ? "When RPDB has no poster for a title, RPDB shows its own image."
              : "Until you add a key, Stremlist shows IMDb posters."}{" "}
            <a
              href="https://ratingposterdb.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-stremlist hover:underline"
            >
              Get a key
            </a>
          </p>
        </div>
      )}
    </div>
  );
}
