import { Fragment } from "react";
import DocPanel from "../components/DocPanel";
import { SplitLayout } from "../components/brand";
import { useSEO } from "../hooks/useSEO";
import { LEGAL_SECTIONS, LEGAL_UPDATED } from "../content/terms";
import { SITE } from "../content/site";

function ContactText({ text }: { text: string }) {
  return text.split(SITE.contact).map((part, index) => (
    <Fragment key={index}>
      {index > 0 && (
        <a
          href={`mailto:${SITE.contact}`}
          className="font-semibold text-stremlist hover:underline"
        >
          {SITE.contact}
        </a>
      )}
      {part}
    </Fragment>
  ));
}

export default function Terms() {
  useSEO({ path: "/terms" });
  return (
    <SplitLayout
      panel={
        <DocPanel
          title="Terms and privacy"
          lead="How Stremlist works, what it stores, and what you can ask for."
          links={LEGAL_SECTIONS.map((section) => ({
            href: `#${section.id}`,
            label: section.label,
          }))}
        />
      }
    >
      <div className="mx-auto max-w-2xl divide-y divide-black/10 p-5 pb-16 sm:p-8 lg:p-12">
        {LEGAL_SECTIONS.map((section) => (
          <section
            key={section.id}
            id={section.id}
            className="scroll-mt-6 py-10 first:pt-0 last:pb-0"
          >
            <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
              {section.label}
            </h2>
            <p className="mt-1 mb-6 text-sm text-black/45">
              Last updated:{" "}
              {new Date(`${LEGAL_UPDATED}T00:00:00Z`).toLocaleDateString(
                "en-US",
                {
                  month: "long",
                  day: "numeric",
                  year: "numeric",
                  timeZone: "UTC",
                },
              )}
            </p>
            <div className="space-y-5 text-[15px] leading-relaxed text-pretty text-black/65">
              {section.clauses.map((clause) => (
                <div key={clause.title}>
                  <h3 className="mb-1 font-bold text-ink">{clause.title}</h3>
                  {clause.blocks.map((block, index) =>
                    block.kind === "paragraph" ? (
                      <p key={index} className={index > 0 ? "mt-2" : undefined}>
                        <ContactText text={block.text} />
                      </p>
                    ) : (
                      <ul
                        key={index}
                        className="list-disc list-inside mt-2 space-y-1 ml-2"
                      >
                        {block.items.map((item) => (
                          <li key={item.label}>
                            <strong>{item.label}</strong> {item.text}
                          </li>
                        ))}
                      </ul>
                    ),
                  )}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </SplitLayout>
  );
}
