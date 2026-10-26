import { VERSIONS } from "../content/changelog";
import DocPanel from "../components/DocPanel";
import Footer from "../components/Footer";
import { SplitLayout } from "../components/brand";
import { useSEO } from "../hooks/useSEO";
import { cn } from "@/lib/utils";

const BADGE_CLASSES: Record<
  (typeof VERSIONS)[number]["changes"][number]["type"],
  string
> = {
  enhancement: "bg-brand text-black",
  bugfix: "bg-black/[0.06] text-black/70",
  performance: "bg-ink text-cloud",
  security: "bg-red-100 text-red-700",
};

/** An anchor for a version, such as "v1-10-0". */
function versionId(version: string) {
  return version.replaceAll(".", "-");
}

export default function Changelog() {
  useSEO({ path: "/changelog" });

  return (
    <SplitLayout
      siteLinksBelow={false}
      panel={
        <DocPanel
          title="Changelog"
          lead="A history of updates and improvements to Stremlist."
          links={VERSIONS.map((v) => ({
            href: `#${versionId(v.version)}`,
            label: v.version,
            detail: v.date,
          }))}
        />
      }
    >
      <div className="mx-auto max-w-3xl p-5 pb-12 sm:p-8 lg:p-12">
        {VERSIONS.map((v) => (
          <section
            key={v.version}
            id={versionId(v.version)}
            aria-labelledby={`${versionId(v.version)}-title`}
            className="grid scroll-mt-6 gap-1 border-t border-black/10 py-10 first:border-t-0 first:pt-0 sm:grid-cols-[9rem_1fr] sm:gap-8"
          >
            <p className="text-sm text-black/45 sm:pt-1.5">{v.date}</p>
            <div>
              <h2
                id={`${versionId(v.version)}-title`}
                className="text-2xl font-bold tracking-tight"
              >
                {v.version}
              </h2>
              <ul className="mt-4 space-y-3 text-[15px] leading-relaxed text-pretty text-black/65">
                {v.changes.map((change, i) => (
                  <li key={i}>
                    <span
                      className={cn(
                        "mr-2 inline-block rounded-full px-2 py-0.5 align-[1px] text-xs leading-normal font-semibold",
                        BADGE_CLASSES[change.type],
                      )}
                    >
                      {change.label}
                    </span>
                    {change.text}
                  </li>
                ))}
              </ul>
            </div>
          </section>
        ))}

        <div className="mt-6">
          <Footer />
        </div>
      </div>
    </SplitLayout>
  );
}
