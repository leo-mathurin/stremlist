import {
  HOME,
  STEPS,
  TROUBLESHOOTING,
  FEATURES as FEATURES_CONTENT,
  FIND_PLACES as FIND_PLACES_CONTENT,
} from "../content/home";
import { SITE } from "../content/site";
import { publicUserCount } from "../lib/public-stats";
import {
  createRef,
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type RefObject,
} from "react";
import { motion } from "motion/react";
import { Link, Navigate, useSearchParams } from "react-router";
import {
  ArrowDownUp,
  BookmarkCheck,
  Compass,
  House,
  Image as ImageIcon,
  Link2,
  Plug,
  Plus,
  TrendingUp,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { ACCOUNT_KEY_PATTERN } from "@stremlist/shared/constants";
import {
  PROVIDER_IDS,
  PROVIDERS,
  type ProviderId,
} from "@stremlist/shared/providers";
import Footer from "../components/Footer";
import HomeEntry from "../components/HomeEntry";
import {
  Logo,
  ProviderMark,
  SectionHeading,
  SplitLayout,
  Wordmark,
} from "../components/brand";
import StremioPreview from "../components/StremioPreview";
import { AnimatedBeam } from "@/components/ui/animated-beam";
import { ADDON_MANAGER_URL } from "../lib/list-sources";
import { useSEO } from "../hooks/useSEO";
import { cn } from "@/lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

const FIND_ICONS = { Home: House, Discover: Compass } satisfies Record<
  (typeof FIND_PLACES_CONTENT)[number][0],
  LucideIcon
>;
const FIND_PLACES: [LucideIcon, string, string][] = FIND_PLACES_CONTENT.map(
  ([title, body]) => [FIND_ICONS[title], title, body],
);

const FEATURE_ICONS = {
  "Sort and filter": ArrowDownUp,
  "IMDb and Trakt charts": TrendingUp,
  "Actions in Stremio": BookmarkCheck,
  "RPDB posters": ImageIcon,
} satisfies Record<(typeof FEATURES_CONTENT)[number][0], LucideIcon>;
const FEATURES: [LucideIcon, string, string][] = FEATURES_CONTENT.map(
  ([title, body]) => [FEATURE_ICONS[title], title, body],
);

const BEAM_DELAYS = [0, 1.2, 0.5, 1.6, 0.9, 0.2, 1.4];

function ProviderRow({
  provider,
  index,
  anchorRef,
}: {
  provider: ProviderId;
  index: number;
  anchorRef: RefObject<HTMLSpanElement | null>;
}) {
  const soon = PROVIDERS[provider].availability !== "available";
  return (
    <motion.li
      initial={{ opacity: 0 }}
      whileInView={{ opacity: 1 }}
      viewport={{ once: true }}
      transition={{
        delay: index * 0.06,
        duration: 0.3,
        ease: [0.23, 1, 0.32, 1],
      }}
      className="flex items-center gap-2.5 sm:gap-3"
    >
      <ProviderMark
        provider={provider}
        className={cn("size-9 sm:size-10", soon && "opacity-50")}
      />
      <span className="flex flex-col items-start gap-0.5">
        <span
          className={cn(
            "font-semibold whitespace-nowrap",
            soon ? "text-black/40" : "text-ink",
          )}
        >
          {PROVIDERS[provider].label}
        </span>
        {soon && (
          <span className="rounded-full bg-black/5 px-1.5 py-px text-2xs leading-4 font-semibold text-black/45">
            Soon
          </span>
        )}
      </span>
      <span ref={anchorRef} className="ml-auto size-0" />
    </motion.li>
  );
}

function ProvidersDiagram() {
  const containerRef = useRef<HTMLDivElement>(null);
  const hubRef = useRef<HTMLDivElement>(null);
  const [anchorRefs] = useState(() =>
    PROVIDER_IDS.map(() => createRef<HTMLSpanElement>()),
  );

  return (
    <section aria-labelledby="providers-title" className="space-y-6">
      <SectionHeading
        id="providers-title"
        title={HOME.providersTitle}
        lead={HOME.providersLead}
      />
      <div className="relative overflow-hidden rounded-3xl bg-muted ring-1 ring-black/5">
        <div
          aria-hidden="true"
          className="bg-dot-grid absolute inset-0 opacity-20"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-linear-to-b from-background/60 from-10% via-transparent to-background/60 to-90%"
        />
        <div
          ref={containerRef}
          className="relative mx-auto flex max-w-lg items-center justify-between gap-6 px-5 py-8 sm:px-8 sm:py-10"
        >
          {PROVIDER_IDS.map((id, i) => (
            <AnimatedBeam
              key={id}
              containerRef={containerRef}
              fromRef={anchorRefs[i]}
              toRef={hubRef}
              delay={BEAM_DELAYS[i % BEAM_DELAYS.length]}
              idle={PROVIDERS[id].availability !== "available"}
            />
          ))}
          <ul className="relative z-10 flex flex-col gap-3 sm:gap-4">
            {PROVIDER_IDS.map((id, i) => (
              <ProviderRow
                key={id}
                provider={id}
                index={i}
                anchorRef={anchorRefs[i]}
              />
            ))}
          </ul>
          <div className="relative z-10 flex flex-col items-center">
            <div ref={hubRef} className="flex">
              <Logo size={64} />
            </div>
            <span className="absolute top-full mt-2 text-sm font-bold">
              Stremlist
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

function TroubleshootingItem({
  problem,
  fix,
}: {
  problem: string;
  fix: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <div className="border-b border-black/10">
        <h3>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              id={`${id}-button`}
              aria-controls={`${id}-panel`}
              className="flex w-full cursor-pointer items-center justify-between gap-4 py-4 text-left font-semibold"
            >
              {problem}
              <Plus
                aria-hidden="true"
                className={cn(
                  "size-4 shrink-0 text-black/40 transition-transform duration-200 ease-out-quint motion-reduce:transition-none",
                  open && "rotate-45",
                )}
              />
            </button>
          </CollapsibleTrigger>
        </h3>
        <CollapsibleContent
          id={`${id}-panel`}
          role="region"
          aria-labelledby={`${id}-button`}
        >
          <p className="pr-8 pb-4 text-pretty text-black/60">{fix}</p>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

const COUNTER_DIGITS = 6;

function LiveCount({ count }: { count: number }) {
  const [rolled, setRolled] = useState(false);
  useEffect(() => {
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setRolled(true));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, []);

  const digits = String(count).padStart(COUNTER_DIGITS, "0").split("");
  const leadingZeros = digits.length - String(count).length;
  const label = count === 1 ? "person uses Stremlist" : "people use Stremlist";

  return (
    <div>
      <p className="sr-only">
        {count.toLocaleString("en")} {label}
      </p>
      <div
        aria-hidden="true"
        className="flex items-center gap-counter text-wordmark leading-none font-bold tabular-nums sm:text-5xl xl:text-6xl"
      >
        {digits.map((digit, i) => {
          const fromEnd = digits.length - 1 - i;
          return (
            <Fragment key={i}>
              {i > 0 && fromEnd % 3 === 2 && (
                <span className="w-[0.28em] self-end pb-counter-comma text-center text-white/25">
                  ,
                </span>
              )}
              <span
                className={cn(
                  "relative h-[1.3em] w-[0.82em] overflow-hidden rounded-counter bg-white/[0.07]",
                  i < leadingZeros ? "text-white/15" : "text-brand",
                )}
              >
                <span
                  className="flex flex-col translate-y-(--roll) transition-transform delay-(--delay) duration-1400 ease-out-quint motion-reduce:transition-none"
                  style={{
                    "--roll": `-${rolled ? Number(digit) * 10 : 0}%`,
                    "--delay": `${fromEnd * 70}ms`,
                  }}
                >
                  {Array.from({ length: 10 }, (_, n) => (
                    <span
                      key={n}
                      className="flex h-[1.3em] items-center justify-center"
                    >
                      {n}
                    </span>
                  ))}
                </span>
                <span className="absolute inset-x-0 top-1/2 h-px bg-ink/70" />
              </span>
            </Fragment>
          );
        })}
      </div>
      <p className="mt-4 flex items-center gap-2.5 text-sm text-white/60">
        <span className="relative flex size-2">
          <span className="absolute inset-0 rounded-full bg-brand opacity-75 motion-safe:animate-ping" />
          <span className="relative size-2 rounded-full bg-brand" />
        </span>
        {label}
      </p>
    </div>
  );
}

export default function Home() {
  useSEO({ path: "/" });
  const [searchParams] = useSearchParams();
  const [userCount, setUserCount] = useState<number | null>(null);

  useEffect(() => {
    void publicUserCount({ backendUrl: import.meta.env.VITE_BACKEND_URL }).then(
      setUserCount,
    );
  }, []);

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
        {}
        <h1 className="text-hero font-bold tracking-tight text-balance lg:text-hero-wide">
          Your lists,{" "}
          <span className="whitespace-nowrap">
            all in{" "}
            <img
              src="/stremio.png"
              alt=""
              width={256}
              height={256}
              className="mb-[0.08em] inline-block size-[0.82em] align-middle"
            />{" "}
            <span className="text-brand">Stremio.</span>
          </span>
        </h1>
        <p className="mt-5 max-w-md text-lg text-pretty text-white/65">
          {HOME.intro}
        </p>
      </div>
      <HomeEntry />
      {userCount !== null && (
        <div className="border-t border-white/10 pt-8">
          <LiveCount count={userCount} />
        </div>
      )}
    </div>
  );

  return (
    <SplitLayout panel={panel} siteLinksBelow={false}>
      <div className="mx-auto max-w-6xl space-y-16 p-5 pb-12 sm:space-y-20 sm:p-8 lg:p-14">
        <ProvidersDiagram />

        <section className="grid gap-4 md:grid-cols-2">
          <div className="rounded-3xl bg-white p-6 ring-1 ring-black/5 sm:p-7">
            <Link2 className="size-6" />
            <h2 className="mt-4 text-2xl font-bold">{HOME.pasteTitle}</h2>
            <p className="mt-2 text-pretty text-black/60">{HOME.pasteBody}</p>
          </div>
          <div className="rounded-3xl bg-brand p-6 text-black sm:p-7">
            <Plug className="size-6" />
            <h2 className="mt-4 text-2xl font-bold">{HOME.connectTitle}</h2>
            <p className="mt-2 text-pretty text-black/65">{HOME.connectBody}</p>
          </div>
        </section>

        <section aria-labelledby="preview-title" className="space-y-6">
          <SectionHeading
            id="preview-title"
            title={HOME.previewTitle}
            lead={HOME.previewLead}
          />
          <StremioPreview />
        </section>

        <section aria-labelledby="steps-title" className="max-w-xl">
          <SectionHeading
            id="steps-title"
            title={HOME.stepsTitle}
            className="mb-8"
          />
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

        <section aria-labelledby="features-title" className="space-y-6">
          <SectionHeading id="features-title" title={HOME.featuresTitle} />
          <div className="grid gap-4 sm:grid-cols-2">
            {FEATURES.map(([Icon, title, body]) => (
              <div
                key={title}
                className="rounded-3xl bg-white p-5 ring-1 ring-black/5"
              >
                <span className="flex size-10 items-center justify-center rounded-xl bg-brand">
                  <Icon className="size-5 text-black" />
                </span>
                <h3 className="mt-4 font-bold">{title}</h3>
                <p className="mt-1 text-sm text-pretty text-black/60">{body}</p>
              </div>
            ))}
          </div>
          <p className="text-sm text-pretty text-black/55">
            {HOME.nuvio}{" "}
            <a
              href={SITE.nuvio}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-stremlist hover:underline"
            >
              Nuvio
            </a>
            . {HOME.nuvioTail}
          </p>
        </section>

        <section aria-labelledby="find-title" className="space-y-6">
          <SectionHeading
            id="find-title"
            title={HOME.findTitle}
            lead={HOME.findLead}
          />
          <div className="grid gap-6 sm:grid-cols-2">
            {FIND_PLACES.map(([Icon, title, body]) => (
              <div key={title} className="flex gap-3">
                <Icon className="mt-0.5 size-5 shrink-0" />
                <div>
                  <h3 className="font-bold">{title}</h3>
                  <p className="mt-1 text-pretty text-black/60">{body}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="text-sm text-pretty text-black/55">
            {HOME.addonManager}{" "}
            <a
              href={ADDON_MANAGER_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-stremlist hover:underline"
            >
              Stremio Addon Manager
            </a>
            .
          </p>
        </section>

        <section
          aria-labelledby="troubleshooting-title"
          className="max-w-2xl space-y-6"
        >
          <SectionHeading
            id="troubleshooting-title"
            title={HOME.troubleshootingTitle}
            lead={HOME.troubleshootingLead}
          />
          <div className="border-t border-black/10">
            {TROUBLESHOOTING.map(([problem, fix]) => (
              <TroubleshootingItem key={problem} problem={problem} fix={fix} />
            ))}
          </div>
        </section>

        <div>
          <p className="text-sm text-black/50">
            {HOME.disclaimer}{" "}
            <Link to="/terms" className="underline hover:text-stremlist">
              terms and privacy policy
            </Link>
            .
          </p>
          <Footer />
        </div>
      </div>
    </SplitLayout>
  );
}
