// PROTOTYPE (STR-106 poster UI). Throwaway: never merge into main.
// Question: one control to pick IMDb, TMDB or RPDB posters, with the RPDB
// key field only when RPDB is picked. Three variants of the Options card on
// /configure, switched with `?variant=A|B|C` (dev builds only). The variants
// drive the real form state (posterSource, rpdbApiKey), so the preview
// follows them. Leaving RPDB clears the key field and keeps the typed key in
// memory, so picking RPDB again brings it back.
// Sample posters: the same three Titles from each provider. IMDb and TMDB
// URLs were read from their APIs on 2026-11-17. RPDB uses the typed key, or
// RPDB's public free key `t0-free-rpdb` while none is typed.
import { useId, useState } from "react";
import type { PosterSource } from "@stremlist/shared/poster";
import { Check, ChevronDown, Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PrototypeSwitcher } from "./PrototypeSwitcher";

type Choice = PosterSource | "rpdb";

const CHOICES: { value: Choice; label: string; hint: string }[] = [
  {
    value: "imdb",
    label: "IMDb",
    hint: "The posters Stremlist always used.",
  },
  {
    value: "tmdb",
    label: "TMDB",
    hint: "Posters from The Movie Database. When TMDB has none, the IMDb poster shows.",
  },
  {
    value: "rpdb",
    label: "RPDB",
    hint: "Posters with ratings on the cover art. Needs an RPDB API key.",
  },
];
const LOGOS = "Posters from any source can show logos of streaming services.";

export interface PosterFormState {
  posterSource: PosterSource;
  setPosterSource: (source: PosterSource) => void;
  rpdbApiKey: string;
  setRpdbApiKey: (key: string) => void;
}

function usePosterChoice(form: PosterFormState) {
  const [picked, setPicked] = useState<Choice | null>(null);
  const [keptKey, setKeptKey] = useState("");
  const choice: Choice =
    picked ?? (form.rpdbApiKey.trim() ? "rpdb" : form.posterSource);
  const choose = (next: Choice) => {
    setPicked(next);
    if (next === "rpdb") {
      if (!form.rpdbApiKey) form.setRpdbApiKey(keptKey);
      return;
    }
    if (form.rpdbApiKey) setKeptKey(form.rpdbApiKey);
    form.setRpdbApiKey("");
    form.setPosterSource(next);
  };
  return { choice, choose };
}

const SAMPLES = [
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

function samplePoster(
  sample: (typeof SAMPLES)[number],
  choice: Choice,
  rpdbKey: string,
): string {
  if (choice !== "rpdb") return sample[choice];
  const key = encodeURIComponent(rpdbKey.trim() || "t0-free-rpdb");
  return `https://api.ratingposterdb.com/${key}/imdb/poster-default/${sample.id}.jpg`;
}

/** Example posters of one source, the size of the preview tiles. */
function PosterSamples({
  choice,
  rpdbKey,
  size = "md",
  count = SAMPLES.length,
}: {
  choice: Choice;
  rpdbKey: string;
  size?: "sm" | "md";
  count?: number;
}) {
  return (
    <ul className="flex gap-2" aria-label="Example posters">
      {SAMPLES.slice(0, count).map((sample) => (
        <li key={sample.id}>
          <img
            src={samplePoster(sample, choice, rpdbKey)}
            alt={`${sample.name}, example poster`}
            loading="lazy"
            className={cn(
              "aspect-[2/3] rounded-lg bg-black/5 object-cover ring-1 ring-black/5",
              size === "sm" ? "w-9" : "w-[4.5rem] sm:w-20",
            )}
          />
        </li>
      ))}
    </ul>
  );
}

function KeyField({ form }: { form: PosterFormState }) {
  const id = useId();
  const [shown, setShown] = useState(false);
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-semibold">
        RPDB API key
      </label>
      <div className="mt-1 flex items-center gap-1 rounded-2xl bg-black/5 p-1">
        <input
          id={id}
          type={shown ? "text" : "password"}
          value={form.rpdbApiKey}
          onChange={(event) => form.setRpdbApiKey(event.target.value)}
          placeholder="Paste your RPDB API key"
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm outline-none"
        />
        <button
          type="button"
          onClick={() => setShown((current) => !current)}
          aria-label={shown ? "Hide RPDB API key" : "Show RPDB API key"}
          className="flex size-9 shrink-0 items-center justify-center rounded-xl text-black/50 transition-colors hover:bg-white hover:text-ink"
        >
          {shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
      <p className="mt-1.5 text-xs text-black/55">
        {form.rpdbApiKey.trim()
          ? "Stremio gets RPDB posters. When RPDB has none, RPDB shows its own default image."
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
  );
}

/** A: a full-width dropdown, the key field below it. */
function VariantA({ form }: { form: PosterFormState }) {
  const { choice, choose } = usePosterChoice(form);
  const id = useId();
  const examplesId = useId();
  const [examplesOpen, setExamplesOpen] = useState(false);
  // Images load on the first open only; after it, closing animates too.
  const [examplesShown, setExamplesShown] = useState(false);
  const current = CHOICES.find((option) => option.value === choice);
  return (
    <div className="space-y-3">
      <div>
        <label htmlFor={id} className="block font-bold">
          Posters
        </label>
        <p className="mt-0.5 mb-3 text-sm text-black/55">
          Where Stremlist gets the posters of your catalogs. {LOGOS}
        </p>
        <Select
          value={choice}
          onValueChange={(value) => {
            const next = CHOICES.find((option) => option.value === value);
            if (next) choose(next.value);
          }}
        >
          <SelectTrigger id={id} className="h-11 w-full rounded-2xl bg-white">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CHOICES.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
                {option.value === "imdb" && (
                  <span className="ml-1 text-black/45">(default)</span>
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="mt-1.5 text-xs text-black/55">{current?.hint}</p>
        <button
          type="button"
          aria-expanded={examplesOpen}
          aria-controls={examplesId}
          onClick={() => {
            setExamplesOpen((open) => !open);
            setExamplesShown(true);
          }}
          className="mt-2 inline-flex min-h-8 items-center gap-1 rounded-lg text-xs font-semibold text-stremlist hover:underline"
        >
          {examplesOpen ? "Hide example posters" : "Show example posters"}
          <ChevronDown
            className={cn(
              "size-3.5 transition-transform duration-200",
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
            <div className="rounded-2xl bg-black/[0.03] p-3">
              <p className="mb-2 text-xs font-semibold text-black/60">
                Example with {current?.label}
              </p>
              <PosterSamples choice={choice} rpdbKey={form.rpdbApiKey} />
            </div>
          )}
        </div>
      </div>
      {choice === "rpdb" && <KeyField form={form} />}
    </div>
  );
}

/** B: a list of three options, the key field inside the RPDB option. */
function VariantB({ form }: { form: PosterFormState }) {
  const { choice, choose } = usePosterChoice(form);
  const name = useId();
  return (
    <fieldset>
      <legend className="font-bold">Posters</legend>
      <p className="mt-0.5 mb-3 text-sm text-black/55">{LOGOS}</p>
      <div className="divide-y divide-black/5 overflow-hidden rounded-2xl ring-1 ring-black/10">
        {CHOICES.map((option) => {
          const selected = choice === option.value;
          return (
            <div
              key={option.value}
              className={cn(selected ? "bg-brand/10" : "bg-white")}
            >
              <label
                aria-label={option.label}
                className="flex cursor-pointer items-start gap-3 px-4 py-3"
              >
                <input
                  type="radio"
                  name={name}
                  value={option.value}
                  checked={selected}
                  onChange={() => choose(option.value)}
                  className="mt-1 size-4 accent-[var(--color-brand,#f5c518)]"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">
                    {option.label}
                    {option.value === "imdb" && (
                      <span className="ml-1 font-normal text-black/45">
                        (default)
                      </span>
                    )}
                  </span>
                  <span className="block text-xs text-black/55">
                    {option.hint}
                  </span>
                </span>
                <span className="hidden shrink-0 sm:block">
                  <PosterSamples
                    choice={option.value}
                    rpdbKey={form.rpdbApiKey}
                    size="sm"
                  />
                </span>
              </label>
              {selected && option.value === "rpdb" && (
                <div className="px-4 pb-4 pl-11">
                  <KeyField form={form} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

/** C: a compact settings row, label left and a small dropdown right. */
function VariantC({ form }: { form: PosterFormState }) {
  const { choice, choose } = usePosterChoice(form);
  const id = useId();
  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <label htmlFor={id} className="block font-bold">
            Posters
          </label>
          <p className="text-sm text-black/55">
            {CHOICES.find((option) => option.value === choice)?.hint}
          </p>
        </div>
        <Select
          value={choice}
          onValueChange={(value) => {
            const next = CHOICES.find((option) => option.value === value);
            if (next) choose(next.value);
          }}
        >
          <SelectTrigger id={id} className="w-32 shrink-0 rounded-xl bg-white">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {CHOICES.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <ul
        className="mt-4 grid grid-cols-3 gap-2"
        aria-label={`${SAMPLES[0].name} from each source`}
      >
        {CHOICES.map((option) => (
          <li
            key={option.value}
            className={cn(
              "flex flex-col items-center gap-1.5 rounded-2xl p-2 text-xs font-semibold",
              choice === option.value
                ? "bg-brand/15 ring-2 ring-brand"
                : "text-black/45",
            )}
          >
            <img
              src={samplePoster(SAMPLES[0], option.value, form.rpdbApiKey)}
              alt={`${SAMPLES[0].name} from ${option.label}`}
              className={cn(
                "aspect-[2/3] w-full max-w-28 rounded-lg object-cover ring-1 ring-black/5",
                choice !== option.value && "opacity-60",
              )}
            />
            {option.label}
          </li>
        ))}
      </ul>
      {choice === "rpdb" && (
        <div className="mt-4 border-t border-black/5 pt-4">
          <KeyField form={form} />
        </div>
      )}
      <p className="mt-3 flex items-center gap-1.5 text-xs text-black/45">
        <Check className="size-3.5" />
        {LOGOS}
      </p>
    </div>
  );
}

const VARIANTS = [
  { key: "A", name: "Dropdown", render: VariantA },
  { key: "B", name: "Option list", render: VariantB },
  { key: "C", name: "Settings row", render: VariantC },
];

export default function PosterSettingsPrototype({
  variant,
  form,
}: {
  variant: string;
  form: PosterFormState;
}) {
  const current = VARIANTS.find((item) => item.key === variant) ?? VARIANTS[0];
  const Variant = current.render;
  const state = `saves posterSource=${form.posterSource}, rpdbApiKey=${form.rpdbApiKey.trim() ? "set" : "empty"}`;
  return (
    <>
      <div className="rounded-3xl bg-white p-4 ring-1 ring-black/5 sm:p-5">
        {/* A new key per variant resets its local choice. */}
        <Variant key={current.key} form={form} />
      </div>
      <PrototypeSwitcher
        variants={VARIANTS}
        current={current.key}
        state={state}
      />
    </>
  );
}
