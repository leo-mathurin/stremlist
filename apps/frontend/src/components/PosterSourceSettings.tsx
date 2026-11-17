import { useEffect, useId, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import type { PosterSource } from "@stremlist/shared/poster";
import { rpdbPosterUrl } from "@stremlist/shared/poster";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  Images,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PrototypeSwitcher } from "@/components/PrototypeSwitcher";
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
    value: "tvdb",
    label: "TheTVDB",
    hint: "Posters from TheTVDB. When TheTVDB has none, the IMDb poster shows.",
  },
  {
    value: "rpdb",
    label: "RPDB",
    hint: "Rating Poster Database: posters with ratings on the cover art. Needs your RPDB API key.",
  },
];

// PROTOTYPE (STR-106 examples). Throwaway: never merge into main.
/** The same Titles from IMDb, TMDB and TheTVDB, to compare them. */
const EXAMPLES = [
  {
    id: "tt1190634",
    name: "The Boys",
    imdb: "https://m.media-amazon.com/images/M/MV5BZjU4OWNiYzQtMzc1NS00NjZlLTgyYTctZWY4ZmEzMTkxYjA4XkEyXkFqcGc@._V1_QL75_UX240_.jpg",
    tmdb: "https://image.tmdb.org/t/p/w342/in1R2dDc421JxsoRWaIIAqVI2KE.jpg",
    tvdb: "https://artworks.thetvdb.com/banners/posters/5c5c402b075cc_t.jpg",
  },
  {
    id: "tt4574334",
    name: "Stranger Things",
    imdb: "https://m.media-amazon.com/images/M/MV5BMjEzMDAxOTUyMV5BMl5BanBnXkFtZTgwNzAxMzYzOTE@._V1_QL75_UX240_.jpg",
    tmdb: "https://image.tmdb.org/t/p/w342/uOOtwVbSr4QDjAGIifLDwpb2Pdl.jpg",
    tvdb: "https://artworks.thetvdb.com/banners/posters/305288-4_t.jpg",
  },
  {
    id: "tt11280740",
    name: "Severance",
    imdb: "https://m.media-amazon.com/images/M/MV5BZDI5YzJhODQtMzQyNy00YWNmLWIxMjUtNDBjNjA5YWRjMzExXkEyXkFqcGc@._V1_QL75_UX240_.jpg",
    tmdb: "https://image.tmdb.org/t/p/w342/pPHpeI2X1qEd1CS1SeyrdhZ4qnT.jpg",
    tvdb: "https://artworks.thetvdb.com/banners/v4/series/371980/posters/621096b26f0e2_t.jpg",
  },
  {
    id: "tt3581920",
    name: "The Last of Us",
    imdb: "https://m.media-amazon.com/images/M/MV5BYWI3ODJlMzktY2U5NC00ZjdlLWE1MGItNWQxZDk3NWNjN2RhXkEyXkFqcGc@._V1_QL75_UX240_.jpg",
    tmdb: "https://image.tmdb.org/t/p/w342/dmo6TYuuJgaYinXBPjrgG9mB5od.jpg",
    tvdb: "https://artworks.thetvdb.com/banners/v4/series/392256/posters/6362e8b41ca10_t.jpg",
  },
  {
    id: "tt10919420",
    name: "Squid Game",
    imdb: "https://m.media-amazon.com/images/M/MV5BMDcxYjg1OTctYmUxZi00ZjhjLWIwNTMtNmI2M2Y4OTU1YWU2XkEyXkFqcGc@._V1_QL75_UX240_.jpg",
    tmdb: "https://image.tmdb.org/t/p/w342/1QdXdRYfktUSONkl1oD5gc6Be0s.jpg",
    tvdb: "https://artworks.thetvdb.com/banners/v4/series/383275/posters/6151351c5420c_t.jpg",
  },
  {
    id: "tt14452776",
    name: "The Bear",
    imdb: "https://m.media-amazon.com/images/M/MV5BMjk2NWI5OTctODcwYy00NGRmLWFmN2YtOTZiNzFiYjVlODBkXkEyXkFqcGc@._V1_QL75_UX240_.jpg",
    tmdb: "https://image.tmdb.org/t/p/w342/eKfVzzEazSIjJMrw9ADa2x8ksLz.jpg",
    tvdb: "https://artworks.thetvdb.com/banners/v4/series/403294/posters/62cb2fad70271_t.jpg",
  },
  {
    id: "tt15398776",
    name: "Oppenheimer",
    imdb: "https://m.media-amazon.com/images/M/MV5BN2JkMDc5MGQtZjg3YS00NmFiLWIyZmQtZTJmNTM5MjVmYTQ4XkEyXkFqcGc@._V1_QL75_UX240_.jpg",
    tmdb: "https://image.tmdb.org/t/p/w342/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg",
    tvdb: "https://artworks.thetvdb.com/banners/v4/movie/287533/posters/64552f43bff1e_t.jpg",
  },
  {
    id: "tt15239678",
    name: "Dune: Part Two",
    imdb: "https://m.media-amazon.com/images/M/MV5BNTc0YmQxMjEtODI5MC00NjFiLTlkMWUtOGQ5NjFmYWUyZGJhXkEyXkFqcGc@._V1_QL75_UX240_.jpg",
    tmdb: "https://image.tmdb.org/t/p/w342/6izwz7rsy95ARzTR3poZ8H6c5pp.jpg",
    tvdb: "https://artworks.thetvdb.com/banners/v4/movie/290272/posters/65a3fccf3815b_t.jpg",
  },
  {
    id: "tt1517268",
    name: "Barbie",
    imdb: "https://m.media-amazon.com/images/M/MV5BYjI3NDU0ZGYtYjA2YS00Y2RlLTgwZDAtYTE2YTM5ZjE1M2JlXkEyXkFqcGc@._V1_QL75_UX240_.jpg",
    tmdb: "https://image.tmdb.org/t/p/w342/iuFNMS8U5cb6xfzi51Dbkovj7vM.jpg",
    tvdb: "https://artworks.thetvdb.com/banners/v4/movie/16612/posters/64ba61bb1dc73_t.jpg",
  },
  {
    id: "tt0111161",
    name: "The Shawshank Redemption",
    imdb: "https://m.media-amazon.com/images/M/MV5BMDAyY2FhYjctNDc5OS00MDNlLThiMGUtY2UxYWVkNGY2ZjljXkEyXkFqcGc@._V1_QL75_UX240_.jpg",
    tmdb: "https://image.tmdb.org/t/p/w342/9cqNxx0GxF0bflZmeSMuL5tnGzr.jpg",
    tvdb: "https://artworks.thetvdb.com/banners/v4/movie/190/posters/6089f8cd44f59_t.jpg",
  },
];

const EXAMPLE_VARIANTS = [
  { key: "A", name: "scroll strip" },
  { key: "B", name: "fit to width" },
  { key: "C", name: "strip + arrows" },
];

const POSTER =
  "aspect-[2/3] w-full rounded-lg bg-black/5 object-cover ring-1 ring-black/5";

function posterUrl(
  source: PosterSource,
  rpdbApiKey: string,
  example: (typeof EXAMPLES)[number],
): string {
  return source === "rpdb"
    ? rpdbPosterUrl(rpdbApiKey, example.id)
    : example[source];
}

/** Example posters of `source`; RPDB ones need the key. */
function Examples({
  source,
  rpdbApiKey,
  variant,
}: {
  source: PosterSource;
  rpdbApiKey: string;
  variant: string;
}) {
  const strip = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });
  const updateEdges = () => {
    const el = strip.current;
    if (!el) return;
    setEdges({
      start: el.scrollLeft <= 1,
      end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1,
    });
  };
  useEffect(updateEdges, [variant]);

  if (source === "rpdb" && !rpdbApiKey.trim()) {
    return (
      <p className="text-xs text-black/55">
        Add your RPDB API key to see examples.
      </p>
    );
  }
  const items = (itemClass: string) =>
    EXAMPLES.map((example) => (
      <li key={example.id} className={itemClass}>
        <img
          src={posterUrl(source, rpdbApiKey, example)}
          alt={`${example.name}, example poster`}
          loading="lazy"
          decoding="async"
          draggable={false}
          className={POSTER}
        />
      </li>
    ));

  if (variant === "B") {
    // One row of as many posters as fit; the others take no height.
    return (
      <ul
        aria-label="Example posters"
        className="grid auto-rows-[0] grid-cols-[repeat(auto-fill,minmax(4.25rem,1fr))] grid-rows-[auto] gap-x-2 overflow-hidden sm:grid-cols-[repeat(auto-fill,minmax(5rem,1fr))]"
      >
        {items("min-w-0")}
      </ul>
    );
  }

  const fade = cn(
    "[--fade:2.5rem] [mask-image:linear-gradient(to_right,transparent,black_var(--fade-start),black_calc(100%-var(--fade-end)),transparent)]",
    edges.start ? "[--fade-start:0px]" : "[--fade-start:var(--fade)]",
    edges.end ? "[--fade-end:0px]" : "[--fade-end:var(--fade)]",
  );
  const list = (
    <ul
      ref={strip}
      aria-label="Example posters"
      onScroll={updateEdges}
      className={cn(
        "-mx-3 flex snap-x snap-mandatory scroll-px-3 gap-2 overflow-x-auto overscroll-x-contain px-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        fade,
      )}
    >
      {items("w-[4.5rem] shrink-0 snap-start sm:w-20")}
    </ul>
  );
  if (variant !== "C") return list;

  const page = (direction: 1 | -1) => {
    const el = strip.current;
    if (!el) return;
    el.scrollBy({ left: direction * el.clientWidth * 0.8, behavior: "smooth" });
  };
  const arrow =
    "absolute top-1/2 z-10 flex size-8 -translate-y-1/2 items-center justify-center rounded-full bg-white text-ink shadow-md ring-1 ring-black/10 transition-opacity duration-150 hover:bg-white/90 disabled:pointer-events-none disabled:opacity-0";
  return (
    <div className="relative">
      {list}
      <button
        type="button"
        aria-label="Previous examples"
        disabled={edges.start}
        onClick={() => page(-1)}
        className={cn(arrow, "-left-1")}
      >
        <ChevronLeft aria-hidden className="size-4" />
      </button>
      <button
        type="button"
        aria-label="Next examples"
        disabled={edges.end}
        onClick={() => page(1)}
        className={cn(arrow, "-right-1")}
      >
        <ChevronRight aria-hidden className="size-4" />
      </button>
    </div>
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
  const [searchParams] = useSearchParams();
  const variant = searchParams.get("variant") ?? "A";

  return (
    <div className="space-y-3">
      <PrototypeSwitcher
        variants={EXAMPLE_VARIANTS}
        current={variant}
        state={`${value}, examples ${examplesOpen ? "open" : "closed"}`}
      />
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
                {/* One inline element, so the name keeps its space. */}
                <span>
                  {source.label}
                  {source.value === "imdb" && (
                    <>
                      {" "}
                      <span className="text-black/45">(default)</span>
                    </>
                  )}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="mt-1.5 flex items-center justify-between gap-3">
          <p className="text-xs text-pretty text-black/55">
            {current?.hint}
            {value === "tvdb" && (
              // TheTVDB's API terms ask for this attribution, with a link.
              <>
                {" "}
                Metadata provided by{" "}
                <a
                  href="https://thetvdb.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold text-stremlist hover:underline"
                >
                  TheTVDB
                </a>
                .
              </>
            )}
          </p>
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
                <Examples
                  source={value}
                  rpdbApiKey={rpdbApiKey}
                  variant={variant}
                />
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
