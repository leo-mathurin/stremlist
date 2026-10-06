import { useEffect, useState } from "react";
import { Link, Navigate, useSearchParams } from "react-router";
import { motion } from "motion/react";
import { Link2, Plug } from "lucide-react";
import { ACCOUNT_KEY_PATTERN } from "@stremlist/shared/constants";
import { PROVIDERS } from "@stremlist/shared/providers";
import Footer from "../components/Footer";
import HomeEntry from "../components/HomeEntry";
import {
  Eyebrow,
  Logo,
  ProviderMark,
  SplitLayout,
  Wordmark,
} from "../components/brand";
import { api } from "../lib/api";
import { ADDON_MANAGER_URL, PROVIDER_ORDER } from "../lib/list-sources";
import { useSEO } from "../hooks/useSEO";

const STEPS = [
  [
    "Add your Lists",
    "Paste links to watchlists and lists, or connect your Trakt, Simkl or MDBList account. Mix as many sites as you like.",
  ],
  [
    "Arrange your rows",
    "Rename, reorder, sort and filter each List. Every List becomes its own catalog.",
  ],
  [
    "Install once",
    "Save to get your Addon URL and install it in Stremio. Your Lists refresh on their own, about every 30 minutes.",
  ],
] as const;

const FEATURES = [
  [
    "Sort and filter",
    "Sort each List by date added, title, year or rating, and filter it by genre, decade, runtime or rating.",
  ],
  [
    "IMDb and Trakt charts",
    "Add Most Popular, Top 250, Box Office or Trakt Trending as ready-made catalogs, no account needed.",
  ],
  [
    "Actions in Stremio",
    "With a connected account, add a title to your watchlist, mark it as watched or rate it from its page in Stremio.",
  ],
  [
    "RPDB posters",
    "Add a Rating Poster Database key to show ratings right on the cover art.",
  ],
] as const;

const PREVIEW_ROWS = [
  { title: "My watchlist", provider: "imdb" },
  { title: "Weekend picks", provider: "trakt" },
  { title: "Envies", provider: "senscritique" },
] as const;

const POSTER_TONES = [
  "#2a2a2a",
  "#4a4a4a",
  "#d4d4d4",
  "#1c1c1c",
  "#a3a3a3",
  "#5c5c5c",
];

const ROW = 44;

function ProvidersDiagram() {
  const height = PROVIDER_ORDER.length * ROW;
  const mid = height / 2;

  return (
    <section aria-labelledby="diagram-title">
      <Eyebrow className="mb-6">
        <span id="diagram-title">Many sites, one addon</span>
      </Eyebrow>
      <div className="flex items-center">
        <ul className="shrink-0">
          {PROVIDER_ORDER.map((id) => {
            const soon = PROVIDERS[id].availability !== "available";
            return (
              <li
                key={id}
                className="flex items-center gap-2.5"
                style={{ height: ROW }}
              >
                <ProviderMark provider={id} />
                <span className="flex w-24 flex-col leading-tight sm:w-28">
                  <span
                    className={
                      soon ? "font-semibold text-black/40" : "font-semibold"
                    }
                  >
                    {PROVIDERS[id].label}
                  </span>
                  {soon && (
                    <span className="text-[11px] font-bold uppercase tracking-wider text-black/40">
                      Soon
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
        <svg
          className="min-w-8 flex-1"
          viewBox={`0 0 100 ${height}`}
          preserveAspectRatio="none"
          style={{ height }}
          aria-hidden="true"
        >
          {PROVIDER_ORDER.map((id, i) => {
            const y = ROW / 2 + i * ROW;
            const info = PROVIDERS[id];
            const soon = info.availability !== "available";
            const connects = info.connection !== "none" && !soon;
            return (
              <path
                key={id}
                d={`M0 ${y} C 55 ${y}, 45 ${mid}, 100 ${mid}`}
                stroke={
                  connects
                    ? "#141414"
                    : soon
                      ? "rgba(0,0,0,0.1)"
                      : "rgba(0,0,0,0.28)"
                }
                strokeWidth={connects ? 2 : 1.5}
                strokeDasharray={connects ? undefined : "4 4"}
                fill="none"
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </svg>
        {/* On phones "In Stremio" hangs below the Stremlist node, so the
            Provider lines still meet the node's center. */}
        <div className="relative flex shrink-0 items-center">
          <div className="flex flex-col items-center gap-2 rounded-3xl bg-ink px-4 py-4 sm:px-6 sm:py-5">
            <Logo size={40} />
            <span className="text-sm font-bold text-cloud">Stremlist</span>
          </div>
          <div className="absolute top-full left-1/2 flex -translate-x-1/2 flex-col items-center sm:static sm:translate-x-0 sm:flex-row">
            <span
              aria-hidden="true"
              className="block h-6 w-0.5 bg-ink sm:h-0.5 sm:w-6 lg:w-10"
            />
            <div className="flex flex-col items-center gap-1 rounded-3xl bg-brand px-4 py-3 text-black sm:px-5 sm:py-4">
              <span className="flex gap-0.5" aria-hidden="true">
                {[0, 1, 2].map((k) => (
                  <span
                    key={k}
                    className="aspect-[2/3] w-2.5 rounded-[3px] bg-black/75"
                  />
                ))}
              </span>
              <span className="text-xs font-bold whitespace-nowrap">
                In Stremio
              </span>
            </div>
          </div>
        </div>
      </div>
      <p className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-xs text-black/55">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-5 bg-ink" />
          Paste a link or connect your account
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-5 border-t border-dashed border-black/40" />
          Paste a link
        </span>
      </p>
    </section>
  );
}

function StremioHomePreview() {
  return (
    <div
      className="space-y-5 rounded-3xl bg-white p-5 ring-1 ring-black/5"
      aria-label="Example of a Stremio home with three Lists"
      role="img"
    >
      <p className="text-xs font-semibold uppercase tracking-wider text-black/40">
        Your Stremio home
      </p>
      {PREVIEW_ROWS.map((row, idx) => (
        <div key={row.title}>
          <div className="mb-2 flex items-center gap-2">
            <span className="font-bold">{row.title}</span>
            <span className="rounded-full bg-black/5 px-2 py-0.5 text-[11px] text-black/55">
              {PROVIDERS[row.provider].label}
            </span>
          </div>
          <div className="flex gap-2 overflow-hidden">
            {[0, 1, 2, 3, 4, 5].map((k) => (
              <div
                key={k}
                className="aspect-[2/3] w-16 shrink-0 rounded-xl md:w-20"
                style={{
                  background: POSTER_TONES[(idx + k) % POSTER_TONES.length],
                }}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function Home() {
  useSEO({
    title: "Stremlist - Your watchlists and lists, all in Stremio",
    description:
      "Free Stremio addon that shows your watchlists and lists from IMDb, Trakt, Simkl, MDBList, JustWatch and SensCritique as catalogs on your Stremio home.",
    canonical: "https://stremlist.com/",
  });
  const [searchParams] = useSearchParams();
  const [userCount, setUserCount] = useState<number | null>(null);

  useEffect(() => {
    api.stats
      .$get()
      .then((r) => r.json())
      .then((data) => setUserCount(data.activeUsers))
      .catch(() => {});
  }, []);

  // Old links sent returning users to `/?userId=ur…`; their install lives on
  // the configure page now.
  const legacyUserId = searchParams.get("userId");
  if (legacyUserId && ACCOUNT_KEY_PATTERN.test(legacyUserId)) {
    return (
      <Navigate
        to={`/configure?account=${encodeURIComponent(legacyUserId)}`}
        replace
      />
    );
  }

  const panel = (
    <div className="space-y-10">
      <Wordmark />
      <div>
        <h1 className="text-4xl leading-[1.05] font-bold tracking-tight text-balance sm:text-5xl xl:text-6xl">
          Your watchlists and lists, all in{" "}
          <span className="text-brand">Stremio.</span>
        </h1>
        <p className="mt-6 max-w-md text-lg text-pretty text-white/70">
          Paste a link from IMDb, Trakt, MDBList, JustWatch or SensCritique, or
          connect Trakt, Simkl or MDBList. Every List shows up as its own row on
          your Stremio home.
        </p>
      </div>
      <HomeEntry />
      <div className="min-h-5">
        {userCount !== null && userCount > 0 && (
          <motion.p
            className="flex items-center gap-2 text-sm text-white/60"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 25 }}
          >
            <span className="size-2 rounded-full bg-brand" />
            Live on {userCount.toLocaleString("en")} Stremio homes
          </motion.p>
        )}
      </div>
    </div>
  );

  return (
    <SplitLayout panel={panel} siteLinksBelow={false}>
      <div className="space-y-16 p-5 pb-12 sm:space-y-20 sm:p-8 lg:p-14">
        <ProvidersDiagram />

        <section className="grid gap-4 md:grid-cols-2">
          <div className="rounded-3xl bg-white p-6 ring-1 ring-black/5 sm:p-7">
            <Link2 className="size-6" />
            <h2 className="mt-4 text-2xl font-bold">Paste a link</h2>
            <p className="mt-2 text-pretty text-black/60">
              Any public watchlist or list from a supported site. Stremlist
              finds the site and the list for you.
            </p>
          </div>
          <div className="rounded-3xl bg-brand p-6 text-black sm:p-7">
            <Plug className="size-6" />
            <h2 className="mt-4 text-2xl font-bold">Connect an account</h2>
            <p className="mt-2 text-pretty text-black/65">
              Connect Trakt, Simkl or MDBList to add your private lists,
              recommendations and Up Next, and to use Actions in Stremio.
            </p>
          </div>
        </section>

        <section className="space-y-6">
          <Eyebrow>What you get</Eyebrow>
          <StremioHomePreview />
        </section>

        <section className="max-w-xl">
          <Eyebrow className="mb-6">How it works</Eyebrow>
          <ol className="relative space-y-8 border-l-2 border-dashed border-black/15 pl-8">
            {STEPS.map(([title, body], i) => (
              <li key={title} className="relative">
                <span className="absolute -left-[49px] flex size-8 items-center justify-center rounded-full bg-brand text-sm font-bold text-black">
                  {i + 1}
                </span>
                <h3 className="text-xl font-bold">{title}</h3>
                <p className="text-pretty text-black/60">{body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="space-y-6">
          <Eyebrow>Features</Eyebrow>
          <div className="grid gap-4 sm:grid-cols-2">
            {FEATURES.map(([title, body]) => (
              <div
                key={title}
                className="rounded-3xl bg-white p-5 ring-1 ring-black/5"
              >
                <h3 className="font-bold">{title}</h3>
                <p className="mt-1 text-sm text-pretty text-black/60">{body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-3xl bg-white p-6 ring-1 ring-black/5">
            <h2 className="text-lg font-bold">
              Where to find your catalogs in Stremio
            </h2>
            <ul className="mt-3 space-y-2 text-sm text-black/65">
              <li>
                <strong className="text-ink">Home:</strong> each List is its own
                row on the Stremio home page.
              </li>
              <li>
                <strong className="text-ink">Discover:</strong> your Lists show
                as catalog filters.
              </li>
              <li>
                New addons show last. To move Stremlist up, use{" "}
                <a
                  href={ADDON_MANAGER_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold text-stremlist hover:underline"
                >
                  Stremio Addon Manager
                </a>
                .
              </li>
            </ul>
          </div>
          <div className="rounded-3xl bg-white p-6 ring-1 ring-black/5">
            <h2 className="text-lg font-bold">Troubleshooting</h2>
            <ul className="mt-3 space-y-2 text-sm text-black/65">
              <li>
                Make sure your lists are public, or connect the account that
                owns them.
              </li>
              <li>
                Changed your Lists or their titles? Reinstall Stremlist so
                Stremio reads the new catalogs.
              </li>
              <li>
                If Stremio shows "Failed to fetch", restart Stremio, or try
                Stremio Web.
              </li>
              <li>
                Lost the configure page? Open it from the Stremlist addon in
                Stremio, or paste your Addon URL above.
              </li>
            </ul>
          </div>
        </section>

        <p className="text-sm text-black/50">
          Stremlist only organizes your lists. It does not host or link to any
          video. Read the{" "}
          <Link to="/terms" className="underline hover:text-stremlist">
            terms and privacy policy
          </Link>
          .
        </p>

        <Footer />
      </div>
    </SplitLayout>
  );
}
