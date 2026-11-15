import { useRef } from "react";
import { motion, useInView, useReducedMotion } from "motion/react";
import { ChevronRight, Search } from "lucide-react";
import type { ProviderId } from "@stremlist/shared/providers";
import { ProviderMark } from "./brand";

/** Example Lists, each inView from a different Provider. */
const ROWS: {
  provider: ProviderId;
  title: string;
  type: "Movie" | "Series";
  items: [imdbId: string, title: string][];
}[] = [
  {
    provider: "imdb",
    title: "My watchlist",
    type: "Movie",
    items: [
      ["tt0068646", "The Godfather"],
      ["tt15239678", "Dune: Part Two"],
      ["tt13238346", "Past Lives"],
      ["tt17009710", "Anatomy of a Fall"],
      ["tt6751668", "Parasite"],
      ["tt0816692", "Interstellar"],
      ["tt2582802", "Whiplash"],
      ["tt15398776", "Oppenheimer"],
      ["tt6710474", "Everything Everywhere All at Once"],
    ],
  },
  {
    provider: "trakt",
    title: "Weekend picks",
    type: "Series",
    items: [
      ["tt11280740", "Severance"],
      ["tt14452776", "The Bear"],
      ["tt11126994", "Arcane"],
      ["tt2788316", "Shōgun"],
      ["tt9253284", "Andor"],
      ["tt5753856", "Dark"],
      ["tt7660850", "Succession"],
      ["tt0903747", "Breaking Bad"],
      ["tt2356777", "True Detective"],
    ],
  },
  {
    provider: "senscritique",
    title: "Envies",
    type: "Movie",
    items: [
      ["tt0211915", "Amélie"],
      ["tt8613070", "Portrait of a Lady on Fire"],
      ["tt0113247", "La Haine"],
      ["tt0245429", "Spirited Away"],
      ["tt1675434", "The Intouchables"],
      ["tt0364569", "Oldboy"],
      ["tt27503384", "Perfect Days"],
      ["tt14039582", "Drive My Car"],
      ["tt0118694", "In the Mood for Love"],
    ],
  },
];

/** Seconds between two rows starting to fill. */
const ROW_GAP = 0.9;
/** Seconds between two posters of a row. */
const POSTER_GAP = 0.07;
const EASE_OUT = [0.23, 1, 0.32, 1] as const;

function posterUrl(imdbId: string) {
  return `https://images.metahub.space/poster/small/${imdbId}/img`;
}

/**
 * Stremio, drawn in its own style, whose catalog rows fill up
 * with posters one List at a time once it scrolls into view.
 */
export default function StremioPreview() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.35 });
  const reduceMotion = useReducedMotion();

  return (
    <div
      ref={ref}
      role="img"
      aria-label="Stremio with three Lists from IMDb, Trakt and SensCritique, each shown as its own row"
      className="overflow-hidden rounded-[22px] bg-[radial-gradient(120%_80%_at_70%_0%,#24214a_0%,#16152a_55%,#13121f_100%)] text-white shadow-[0_24px_60px_-24px_rgba(20,16,48,0.55)] ring-1 ring-black/10 select-none"
    >
      <div className="pt-4 pb-5 pl-4 sm:pl-5">
        <div className="mr-4 mb-5 flex h-8 items-center justify-between rounded-full bg-white/[0.07] px-3.5 text-xs text-white/40 sm:mx-auto sm:max-w-72">
          Search or paste link
          <Search className="size-3.5" />
        </div>

        <div className="space-y-4">
          {ROWS.map((row, r) => {
            const rowDelay = 0.2 + r * ROW_GAP;
            return (
              <div key={row.title}>
                <div className="mb-2 flex h-6 items-center justify-between pr-4">
                  <div className="relative flex items-center">
                    {/* Skeleton title, replaced by the real one */}
                    <motion.span
                      className="absolute h-3 w-32 rounded-full bg-white/10"
                      initial={false}
                      animate={{ opacity: inView ? 0 : 1 }}
                      transition={{ duration: 0.2, delay: rowDelay }}
                    />
                    <motion.span
                      className="flex items-center gap-2"
                      initial={false}
                      animate={
                        inView
                          ? { opacity: 1, transform: "translateX(0px)" }
                          : {
                              opacity: 0,
                              transform: reduceMotion
                                ? "translateX(0px)"
                                : "translateX(-6px)",
                            }
                      }
                      transition={{
                        duration: 0.4,
                        delay: rowDelay,
                        ease: EASE_OUT,
                      }}
                    >
                      <ProviderMark
                        provider={row.provider}
                        className="size-5"
                      />
                      <span className="text-sm font-medium whitespace-nowrap text-white/90 sm:text-base">
                        {row.title} - {row.type}
                      </span>
                    </motion.span>
                  </div>
                  <span className="flex items-center gap-0.5 text-xs text-white/45">
                    See All <ChevronRight className="size-3.5" />
                  </span>
                </div>

                <div className="flex gap-2.5 overflow-hidden [mask-image:linear-gradient(to_right,black_85%,transparent)]">
                  {row.items.map(([imdbId, title], p) => (
                    <div key={imdbId} className="w-[72px] shrink-0 sm:w-[84px]">
                      <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-white/[0.06]">
                        <motion.img
                          src={posterUrl(imdbId)}
                          alt=""
                          width={84}
                          height={126}
                          draggable={false}
                          className="absolute inset-0 size-full object-cover"
                          initial={false}
                          animate={
                            inView
                              ? {
                                  opacity: 1,
                                  transform: "scale(1)",
                                  filter: "blur(0px)",
                                }
                              : {
                                  opacity: 0,
                                  transform: reduceMotion
                                    ? "scale(1)"
                                    : "scale(0.94)",
                                  filter: reduceMotion
                                    ? "blur(0px)"
                                    : "blur(6px)",
                                }
                          }
                          transition={{
                            duration: 0.5,
                            delay: rowDelay + 0.15 + p * POSTER_GAP,
                            ease: EASE_OUT,
                          }}
                        />
                      </div>
                      <motion.p
                        className="mt-1.5 truncate text-center text-[11px] font-semibold text-white/85"
                        initial={false}
                        animate={{ opacity: inView ? 1 : 0 }}
                        transition={{
                          duration: 0.3,
                          delay: rowDelay + 0.3 + p * POSTER_GAP,
                        }}
                      >
                        {title}
                      </motion.p>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
