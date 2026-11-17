// PROTOTYPE (STR-106 poster UI). Throwaway: never merge into main.
// Question: one control to pick IMDb, TMDB or RPDB posters, with the RPDB
// key field only when RPDB is picked. Three variants of the Options card on
// /configure, switched with `?variant=A|B|C` (dev builds only). The variants
// drive the real form state (posterSource, rpdbApiKey), so the preview
// follows them. Leaving RPDB clears the key field and keeps the typed key in
// memory, so picking RPDB again brings it back.
import { useId, useState } from "react";
import type { PosterSource } from "@stremlist/shared/poster";
import { Check, Eye, EyeOff } from "lucide-react";
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
                <span className="min-w-0">
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
