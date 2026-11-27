import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  filterLanguageOptions,
  findLanguageOption,
  formatEnglishName,
  formatLanguageName,
} from "@stremlist/shared/metadata-language";
import type {
  MetadataLanguage,
  MetadataLanguageCode,
} from "@stremlist/shared/metadata-language";
import {
  Check,
  ChevronDown,
  Eye,
  Globe,
  Search,
  Sparkles,
  Star,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface SampleTranslation {
  title: string;
  description: string;
  fallback?: boolean;
}

interface SampleTitle {
  id: string;
  originalTitle: string;
  year: string;
  runtime: string;
  rating: string;
  poster: string;
  fallback: SampleTranslation;
  translations: Partial<Record<MetadataLanguageCode, SampleTranslation>>;
}

const SAMPLE_TITLES: readonly SampleTitle[] = [
  {
    id: "tt15239678",
    originalTitle: "Dune: Part Two",
    year: "2024",
    runtime: "166m",
    rating: "8.5",
    poster: "https://image.tmdb.org/t/p/w342/6izwz7rsy95ARzTR3poZ8H6c5pp.jpg",
    fallback: {
      title: "Dune: Part Two",
      description:
        "Paul Atreides unites with Chani and the Fremen while seeking revenge against the conspirators who destroyed his family.",
    },
    translations: {
      "en-US": {
        title: "Dune: Part Two",
        description:
          "Paul Atreides unites with Chani and the Fremen while seeking revenge against the conspirators who destroyed his family.",
      },
      "it-IT": {
        title: "Dune - Parte due",
        description:
          "Paul Atreides si unisce a Chani e ai Fremen in un viaggio di vendetta contro i cospiratori che hanno distrutto la sua famiglia.",
      },
      "fr-FR": {
        title: "Dune : Deuxième partie",
        description:
          "Paul Atréides s'unit à Chani et aux Fremen pour mener la révolte contre ceux qui ont anéanti sa famille.",
      },
      "es-ES": {
        title: "Dune: Parte dos",
        description:
          "Paul Atreides se une a Chani y a los Fremen mientras busca venganza contra los conspiradores que destruyeron a su familia.",
      },
      "es-MX": {
        title: "Duna: Parte dos",
        description:
          "Paul Atreides se une a Chani y a los Fremen en una senda de venganza contra quienes destruyeron a su familia.",
      },
      "de-DE": {
        title: "Dune: Part Two",
        description:
          "Paul Atreides schließt sich Chani und den Fremen an und sinnt auf Rache an den Verschwörern, die seine Familie zerstörten.",
      },
      "pt-BR": {
        title: "Duna: Parte Dois",
        description:
          "Paul Atreides se une a Chani e aos Fremen em uma jornada de vingança contra os conspiradores que destruíram sua família.",
      },
      "pt-PT": {
        title: "Dune: Parte Dois",
        description:
          "Paul Atreides junta-se a Chani e aos Fremen num caminho de vingança contra os conspiradores que destruíram a sua família.",
      },
      "nl-NL": {
        title: "Dune: Part Two",
        description:
          "Paul Atreides sluit zich aan bij Chani en de Fremen op een wraaktocht tegen de samenzweerders die zijn familie verwoestten.",
      },
      "pl-PL": {
        title: "Diuna: Część druga",
        description:
          "Paul Atryda łączy siły z Chani i Fremenami, szukając zemsty na spiskowcach, którzy zniszczyli jego rodzinę.",
      },
      "ja-JP": {
        title: "デューン 砂の惑星 PART2",
        description:
          "ポール・アトレイデスはチャニとフレメンの民と手を組み、一族を滅ぼした陰謀家たちへの復讐に立ち上がる。",
      },
      "ko-KR": {
        title: "듄: 파트 2",
        description:
          "폴 아트레이데스는 챠니와 프레멘 부족과 손을 잡고 가문을 무너뜨린 음모자들에게 복수할 여정을 시작한다.",
      },
      "tr-TR": {
        title: "Dune: Çöl Gezegeni Bölüm İki",
        description:
          "Paul Atreides, ailesini yok eden komploculardan intikam almak için Chani ve Fremenlerle güçlerini birleştirir.",
      },
    },
  },
  {
    id: "tt11280740",
    originalTitle: "Severance",
    year: "2022",
    runtime: "55m",
    rating: "8.7",
    poster: "https://image.tmdb.org/t/p/w342/pPHpeI2X1qEd1CS1SeyrdhZ4qnT.jpg",
    fallback: {
      title: "Severance",
      description:
        "Mark leads a team of office workers whose memories have been surgically divided between their work and personal lives.",
    },
    translations: {
      "en-US": {
        title: "Severance",
        description:
          "Mark leads a team of office workers whose memories have been surgically divided between their work and personal lives.",
      },
      "it-IT": {
        title: "Scissione",
        description:
          "Mark guida una squadra di impiegati i cui ricordi sono stati divisi chirurgicamente tra vita lavorativa e vita privata.",
      },
      "fr-FR": {
        title: "Severance",
        description:
          "Mark dirige une équipe d'employés dont les souvenirs ont été chirurgicalement séparés entre vie professionnelle et vie privée.",
      },
      "es-ES": {
        title: "Separación",
        description:
          "Mark dirige un equipo de oficinistas cuyos recuerdos han sido divididos quirúrgicamente entre su vida laboral y personal.",
      },
      "de-DE": {
        title: "Severance",
        description:
          "Mark leitet ein Büro-Team, dessen Erinnerungen chirurgisch zwischen Arbeits- und Privatleben getrennt wurden.",
      },
      "pt-BR": {
        title: "Ruptura",
        description:
          "Mark lidera uma equipe de funcionários cujas memórias foram divididas cirurgicamente entre o trabalho e a vida pessoal.",
      },
      "nl-NL": {
        title: "Severance",
        description:
          "Mark leidt een kantoorteam waarvan de herinneringen operatief zijn gescheiden tussen werk en privéleven.",
      },
      "pl-PL": {
        title: "Rozdzielenie",
        description:
          "Mark kieruje zespołem pracowników biurowych, których wspomnienia z pracy i życia prywatnego zostały chirurgicznie rozdzielone.",
      },
      "ja-JP": {
        title: "セヴェランス",
        description:
          "仕事と私生活の記憶を外科手術で分離されたオフィス社員のチームを率いるマークが、会社の謎に迫る。",
      },
      "ko-KR": {
        title: "세브란스: 단절",
        description:
          "직장과 사생활의 기억이 수술로 분리된 사무실 직원들을 이끄는 마크가 회사의 비밀을 마주한다.",
      },
    },
  },
  {
    id: "tt15398776",
    originalTitle: "Oppenheimer",
    year: "2023",
    runtime: "180m",
    rating: "8.3",
    poster: "https://image.tmdb.org/t/p/w342/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg",
    fallback: {
      title: "Oppenheimer",
      description:
        "The story of American scientist J. Robert Oppenheimer and his role in the development of the atomic bomb.",
    },
    translations: {
      "en-US": {
        title: "Oppenheimer",
        description:
          "The story of American scientist J. Robert Oppenheimer and his role in the development of the atomic bomb.",
      },
      "it-IT": {
        title: "Oppenheimer",
        description:
          "La storia dello scienziato americano J. Robert Oppenheimer e del suo ruolo nello sviluppo della bomba atomica.",
      },
      "fr-FR": {
        title: "Oppenheimer",
        description:
          "L'histoire du physicien américain J. Robert Oppenheimer et de son rôle dans la création de la bombe atomique.",
      },
      "es-ES": {
        title: "Oppenheimer",
        description:
          "La historia del científico estadounidense J. Robert Oppenheimer y su papel en el desarrollo de la bomba atómica.",
      },
      "de-DE": {
        title: "Oppenheimer",
        description:
          "Die Geschichte des amerikanischen Physikers J. Robert Oppenheimer und seiner Rolle bei der Entwicklung der Atombombe.",
      },
      "pt-BR": {
        title: "Oppenheimer",
        description:
          "A história do físico americano J. Robert Oppenheimer e seu papel no desenvolvimento da bomba atômica.",
      },
      "nl-NL": {
        title: "Oppenheimer",
        description:
          "Het verhaal van de Amerikaanse natuurkundige J. Robert Oppenheimer en zijn rol bij de ontwikkeling van de atoombom.",
      },
      "pl-PL": {
        title: "Oppenheimer",
        description:
          "Historia amerykańskiego naukowca J. Roberta Oppenheimera i jego roli w stworzeniu bomby atomowej.",
      },
    },
  },
];

function sampleMetaFor(title: SampleTitle, code: MetadataLanguageCode) {
  const exact = title.translations[code];
  return exact ?? { ...title.fallback, fallback: true };
}

/**
 * The language of Title names and plot descriptions in Stremio: English
 * (default), any supported TMDB locale, or Stremio's own metadata addon.
 * Preview posters open on request so their images load only then.
 */
export default function MetadataLanguageSettings({
  value,
  onChange,
}: {
  value: MetadataLanguage;
  onChange: (language: MetadataLanguage) => void;
}) {
  const triggerId = useId();
  const listboxId = useId();
  const previewId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Map<MetadataLanguage, HTMLButtonElement>>(
    new Map(),
  );

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewShown, setPreviewShown] = useState(false);
  const [sampleIndex, setSampleIndex] = useState(0);

  const filtered = useMemo(() => filterLanguageOptions(query), [query]);
  const showStremioOption =
    !query.trim() ||
    "stremio cinemeta tmdb auto own metadata default".includes(
      query.trim().toLowerCase(),
    );

  const flatOptions = useMemo<MetadataLanguage[]>(() => {
    const items: MetadataLanguage[] = [];
    if (showStremioOption) items.push("stremio");
    for (const option of filtered) items.push(option.code);
    return items;
  }, [filtered, showStremioOption]);

  const optionId = (option: MetadataLanguage) =>
    `${listboxId}-option-${option}`;
  const activeOption = open ? flatOptions[highlightedIndex] : undefined;
  const activeOptionId = activeOption ? optionId(activeOption) : undefined;

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const onPointerDown = (event: MouseEvent) => {
      if (
        rootRef.current &&
        event.target instanceof Node &&
        !rootRef.current.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onDocumentKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onDocumentKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !activeOption) return;
    optionRefs.current.get(activeOption)?.scrollIntoView({ block: "nearest" });
  }, [open, activeOption]);

  const openMenu = () => {
    setQuery("");
    const currentIndex =
      value === "stremio"
        ? 0
        : filterLanguageOptions("").findIndex(
            (option) => option.code === value,
          ) + 1;
    setHighlightedIndex(currentIndex >= 0 ? currentIndex : 0);
    setOpen(true);
  };

  const choose = (next: MetadataLanguage) => {
    onChange(next);
    setOpen(false);
    setQuery("");
    triggerRef.current?.focus();
  };

  const selectedLanguage =
    value === "stremio" ? null : findLanguageOption(value);
  const activeSample = SAMPLE_TITLES[sampleIndex] ?? SAMPLE_TITLES[0];
  const sampleMeta =
    value === "stremio"
      ? sampleMetaFor(activeSample, "en-US")
      : sampleMetaFor(activeSample, value);

  const hintText =
    value === "stremio"
      ? "Catalog previews omit the plot. Opening a title uses an available metadata addon (such as Cinemeta or TMDB)."
      : value === "en-US"
        ? "Descriptions from IMDb and TMDB in English, the language Stremlist always used."
        : `Localized titles and descriptions from TMDB. When a title has no ${selectedLanguage?.englishName ?? "localized"} translation, English shows.`;

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor={triggerId} className="block font-bold text-balance">
          Language
        </label>
        <p className="mt-0.5 mb-3 text-sm text-pretty text-black/55">
          The language of titles and descriptions in Stremio.
        </p>

        <div
          ref={rootRef}
          className="relative"
          onBlur={(event) => {
            if (
              open &&
              rootRef.current &&
              !(
                event.relatedTarget instanceof Node &&
                rootRef.current.contains(event.relatedTarget)
              )
            ) {
              setOpen(false);
            }
          }}
        >
          <button
            ref={triggerRef}
            id={triggerId}
            type="button"
            role="combobox"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-haspopup="listbox"
            onClick={() => (open ? setOpen(false) : openMenu())}
            className={cn(
              "flex h-11 w-full items-center justify-between gap-3 rounded-2xl border bg-white px-3.5 text-left text-sm shadow-xs outline-none transition-[border-color,box-shadow,transform] duration-150 ease-out active:scale-98 motion-reduce:active:scale-100 focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/40",
              open ? "border-brand ring-2 ring-brand/30" : "border-input",
            )}
          >
            <span className="flex min-w-0 items-center gap-2.5">
              {selectedLanguage ? (
                <>
                  <Globe
                    className="size-4 shrink-0 text-black/45"
                    aria-hidden="true"
                  />
                  <span className="truncate font-semibold text-ink">
                    {formatLanguageName(selectedLanguage)}
                  </span>
                  {value === "en-US" ? (
                    <span className="shrink-0 text-black/45">(default)</span>
                  ) : (
                    <span className="shrink-0 text-black/45">
                      {selectedLanguage.englishName}
                    </span>
                  )}
                </>
              ) : (
                <>
                  <Sparkles
                    className="size-4 shrink-0 text-black/45"
                    aria-hidden="true"
                  />
                  <span className="truncate font-semibold text-ink">
                    Use Stremio&apos;s metadata
                  </span>
                  <span className="shrink-0 rounded-md bg-black/5 px-1.5 py-0.5 font-mono text-2xs font-medium text-black/55">
                    Auto
                  </span>
                </>
              )}
            </span>
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "size-4 shrink-0 text-black/45 transition-transform duration-200 ease-out motion-reduce:transition-none",
                open && "rotate-180",
              )}
            />
          </button>

          {open && (
            <div className="metadata-popover-in absolute right-0 left-0 z-40 mt-1.5 overflow-hidden rounded-2xl border border-black/10 bg-white shadow-lg">
              <div className="flex items-center gap-2 border-b border-black/5 px-3 py-2">
                <Search
                  className="size-4 shrink-0 text-black/40"
                  aria-hidden="true"
                />
                <input
                  ref={searchRef}
                  type="text"
                  role="combobox"
                  aria-expanded={open}
                  aria-controls={listboxId}
                  aria-autocomplete="list"
                  aria-activedescendant={activeOptionId}
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setHighlightedIndex(0);
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.nativeEvent.isComposing ||
                      event.keyCode === 229
                    ) {
                      return;
                    }
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      setHighlightedIndex((previous) =>
                        flatOptions.length === 0
                          ? 0
                          : (previous + 1) % flatOptions.length,
                      );
                    } else if (event.key === "ArrowUp") {
                      event.preventDefault();
                      setHighlightedIndex((previous) =>
                        flatOptions.length === 0
                          ? 0
                          : (previous - 1 + flatOptions.length) %
                            flatOptions.length,
                      );
                    } else if (event.key === "Enter") {
                      event.preventDefault();
                      const picked = flatOptions[highlightedIndex];
                      if (picked) choose(picked);
                    }
                  }}
                  placeholder="Search language or ISO code (it-IT, French)…"
                  aria-label="Search language"
                  className="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-black/40 outline-none"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => {
                      setQuery("");
                      setHighlightedIndex(0);
                      searchRef.current?.focus();
                    }}
                    className="rounded-md px-1.5 py-0.5 text-xs font-medium text-black/45 hover:bg-black/5 hover:text-ink"
                  >
                    Clear
                  </button>
                )}
              </div>

              <div
                id={listboxId}
                role="listbox"
                aria-label="Metadata language options"
                className="max-h-72 overflow-y-auto overscroll-contain p-1.5"
              >
                {showStremioOption && (
                  <>
                    <button
                      ref={(node) => {
                        if (node) optionRefs.current.set("stremio", node);
                        else optionRefs.current.delete("stremio");
                      }}
                      id={optionId("stremio")}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-label="Use Stremio's metadata"
                      aria-selected={value === "stremio"}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setHighlightedIndex(0)}
                      onClick={() => choose("stremio")}
                      className={cn(
                        "flex w-full items-center justify-between gap-3 rounded-xl px-2.5 py-2 text-left transition-colors duration-100",
                        highlightedIndex === 0
                          ? "bg-black/5"
                          : "bg-transparent",
                      )}
                    >
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                          <Sparkles
                            className="size-3.5 text-black/50"
                            aria-hidden="true"
                          />
                          Use Stremio&apos;s metadata
                        </span>
                        <span className="mt-0.5 block text-xs text-black/50">
                          Omit catalog plots; use your metadata addon on detail
                          pages
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="rounded-md bg-black/5 px-1.5 py-0.5 font-mono text-2xs text-black/50">
                          Auto
                        </span>
                        <span className="flex size-4 items-center justify-center">
                          {value === "stremio" && (
                            <Check
                              className="size-4 text-ink"
                              aria-hidden="true"
                            />
                          )}
                        </span>
                      </span>
                    </button>
                    {filtered.length > 0 && (
                      <div
                        aria-hidden="true"
                        className="my-1.5 h-px bg-black/5"
                      />
                    )}
                  </>
                )}

                {filtered.map((option, index) => {
                  const flatIndex = showStremioOption ? index + 1 : index;
                  const selected = value === option.code;
                  return (
                    <button
                      key={option.code}
                      ref={(node) => {
                        if (node) optionRefs.current.set(option.code, node);
                        else optionRefs.current.delete(option.code);
                      }}
                      id={optionId(option.code)}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={selected}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setHighlightedIndex(flatIndex)}
                      onClick={() => choose(option.code)}
                      className={cn(
                        "flex w-full items-center justify-between gap-3 rounded-xl px-2.5 py-2 text-left text-sm transition-colors duration-100",
                        highlightedIndex === flatIndex
                          ? "bg-black/5"
                          : "bg-transparent",
                      )}
                    >
                      <span className="min-w-0 truncate font-medium text-ink">
                        {formatLanguageName(option)}
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="text-xs text-black/45">
                          {formatEnglishName(option)}
                        </span>
                        <span className="w-11 text-right font-mono text-2xs text-black/40 tabular-nums">
                          {option.code}
                        </span>
                        <span className="flex size-4 items-center justify-center">
                          {selected && (
                            <Check
                              className="size-4 text-ink"
                              aria-hidden="true"
                            />
                          )}
                        </span>
                      </span>
                    </button>
                  );
                })}

                {flatOptions.length === 0 && (
                  <p className="px-3 py-6 text-center text-sm text-black/45">
                    No languages match &ldquo;{query}&rdquo;.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="mt-1.5 flex items-start justify-between gap-3">
          <p className="text-xs text-pretty text-black/55">{hintText}</p>
          <button
            type="button"
            aria-expanded={previewOpen}
            aria-controls={previewId}
            onClick={() => {
              setPreviewOpen((was) => !was);
              setPreviewShown(true);
            }}
            className="flex min-h-8 shrink-0 items-center gap-1 rounded-full bg-black/5 px-2.5 text-xs font-semibold text-black/70 transition-[background-color,transform] duration-150 ease-out hover:bg-black/10 active:scale-96 motion-reduce:active:scale-100 focus-visible:ring-2 focus-visible:ring-brand/60 focus-visible:outline-none"
          >
            <Eye aria-hidden="true" className="size-3.5" />
            Preview
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "size-3.5 text-black/45 transition-transform duration-200 ease-out motion-reduce:transition-none",
                previewOpen && "rotate-180",
              )}
            />
          </button>
        </div>

        <div
          id={previewId}
          inert={!previewOpen}
          className={cn(
            "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
            previewOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
          )}
        >
          <div className="min-h-0 overflow-hidden">
            {previewShown && (
              <div className="mt-3 rounded-2xl bg-stremio-night p-3.5 text-white ring-1 ring-black/10 sm:p-4">
                <div className="mb-3 flex flex-wrap items-center gap-1">
                  {SAMPLE_TITLES.map((item, index) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setSampleIndex(index)}
                      className={cn(
                        "rounded-full px-2.5 py-1 text-2xs font-semibold transition-[background-color,color,transform] duration-150 ease-out active:scale-96 motion-reduce:active:scale-100",
                        index === sampleIndex
                          ? "bg-white/15 text-white"
                          : "text-white/50 hover:bg-white/10 hover:text-white/80",
                      )}
                    >
                      {item.originalTitle}
                    </button>
                  ))}
                </div>

                <div className="flex items-start gap-3.5">
                  <img
                    src={activeSample.poster}
                    alt={`${activeSample.originalTitle}, example poster`}
                    loading="lazy"
                    decoding="async"
                    className="aspect-[2/3] w-16 shrink-0 self-start rounded-lg bg-white/10 object-cover outline outline-1 -outline-offset-1 outline-white/10 sm:w-20"
                  />
                  <div
                    key={`${value}-${activeSample.id}`}
                    className="metadata-text-fade min-w-0 flex-1 space-y-1.5"
                  >
                    {value === "stremio" ? (
                      <>
                        <p className="text-sm font-bold text-white">
                          {activeSample.originalTitle}
                        </p>
                        <p className="flex items-center gap-2 text-2xs text-white/55 tabular-nums">
                          <span>{activeSample.year}</span>
                          <span>·</span>
                          <span>{activeSample.runtime}</span>
                          <span>·</span>
                          <span className="inline-flex items-center gap-0.5 text-brand">
                            <Star
                              className="size-3 fill-current"
                              aria-hidden="true"
                            />
                            {activeSample.rating}
                          </span>
                        </p>
                        <div className="rounded-xl border border-dashed border-white/20 bg-white/5 px-3 py-2 text-xs text-pretty text-white/75">
                          Catalog previews omit the plot in this mode. Opening
                          the title uses an available metadata addon (such as
                          Cinemeta or TMDB).
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                          <p className="text-sm font-bold text-white">
                            {sampleMeta.title}
                          </p>
                          <span className="font-mono text-2xs text-white/45 tabular-nums">
                            {value}
                          </span>
                        </div>
                        <p className="flex items-center gap-2 text-2xs text-white/55 tabular-nums">
                          <span>{activeSample.year}</span>
                          <span>·</span>
                          <span>{activeSample.runtime}</span>
                          <span>·</span>
                          <span className="inline-flex items-center gap-0.5 text-brand">
                            <Star
                              className="size-3 fill-current"
                              aria-hidden="true"
                            />
                            {activeSample.rating}
                          </span>
                        </p>
                        <p className="text-xs leading-relaxed text-pretty text-white/75">
                          {sampleMeta.description}
                        </p>
                        {sampleMeta.fallback && (
                          <p className="text-2xs text-brand/90">
                            No {selectedLanguage?.englishName} translation for
                            this sample title, so English shows.
                          </p>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
