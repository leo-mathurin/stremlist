import { Link } from "react-router";
import Header from "../components/Header";
import Footer from "../components/Footer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type ChangeType = "enhancement" | "bugfix" | "performance" | "security";

interface Change {
  type: ChangeType;
  label: string;
  text: string;
}

interface Version {
  version: string;
  date: string;
  changes: Change[];
}

const BADGE_CLASSES: Record<ChangeType, string> = {
  enhancement: "bg-green-500 text-white border-0 hover:bg-green-500",
  bugfix: "bg-blue-500 text-white border-0 hover:bg-blue-500",
  performance: "bg-orange-400 text-black border-0 hover:bg-orange-400",
  security: "bg-red-500 text-white border-0 hover:bg-red-500",
};

const VERSIONS: Version[] = [
  {
    version: "v1.3.0",
    date: "February 2026",
    changes: [
      {
        type: "bugfix",
        label: "Reliability",
        text: "Fixed recurring backend downtime caused by the previous scraping approach by rebuilding the IMDb scraping flow for better stability.",
      },
      {
        type: "enhancement",
        label: "Feature",
        text: "Added RPDB poster support for improved artwork in catalogs.",
      },
      {
        type: "enhancement",
        label: "Feature",
        text: "Added support for multiple IMDb watchlists in a single setup.",
      },
      {
        type: "enhancement",
        label: "Feature",
        text: 'Added a new "Random" sort order.',
      },
      {
        type: "enhancement",
        label: "Open source",
        text: "Open-sourced Stremlist to make community contributions and transparency easier.",
      },
      {
        type: "performance",
        label: "Architecture",
        text: "Rebuilt deployment around Vercel (frontend + API), replacing the old self-managed Linux VPS setup for simpler operations, easier rollouts, and better uptime.",
      },
    ],
  },
  {
    version: "v1.2.1",
    date: "May 14, 2025",
    changes: [
      {
        type: "enhancement",
        label: "Feature",
        text: 'Added "Date Added" sorting options to display watchlist items in the order they were added to IMDb (oldest first or newest first).',
      },
      {
        type: "enhancement",
        label: "Enhancement",
        text: 'Changed default sorting to "Date Added (Oldest First)" which preserves the natural order from IMDb.',
      },
    ],
  },
  {
    version: "v1.2.0",
    date: "May 12, 2025",
    changes: [
      {
        type: "enhancement",
        label: "Feature",
        text: "Added comprehensive sorting functionality: users can now sort their watchlists by title (A-Z/Z-A), year (newest/oldest first), or rating (highest/lowest first). Sort options are available both during initial setup and in configuration, with preferences persisted consistently across installations.",
      },
    ],
  },
  {
    version: "v1.1.1",
    date: "March 28, 2024",
    changes: [
      {
        type: "enhancement",
        label: "Enhancement",
        text: "Added specific error message for private IMDb watchlists",
      },
      {
        type: "bugfix",
        label: "Bugfix",
        text: "Improved error messaging to provide clearer guidance when issues occur",
      },
    ],
  },
  {
    version: "v1.1.0",
    date: "March 26, 2024",
    changes: [
      {
        type: "performance",
        label: "Performance",
        text: "Replaced HTML scraping with direct GraphQL API calls to improve reliability and efficiency",
      },
      {
        type: "bugfix",
        label: "Bugfix",
        text: "Fixed issue where posters and titles were displayed in French instead of English",
      },
      {
        type: "enhancement",
        label: "Enhancement",
        text: "Increased the watchlist item limit from 250 to 10,000 items",
      },
    ],
  },
  {
    version: "v1.0.0",
    date: "March 19, 2024",
    changes: [
      {
        type: "enhancement",
        label: "Enhancement",
        text: "Initial release of Stremlist",
      },
      {
        type: "enhancement",
        label: "Feature",
        text: "Connect IMDb watchlist to Stremio through user ID",
      },
      {
        type: "enhancement",
        label: "Feature",
        text: "Automatic refresh of watchlist data every 6-12 hours",
      },
      {
        type: "enhancement",
        label: "Feature",
        text: "Support for movies and TV series from IMDb watchlists",
      },
    ],
  },
];

export default function Changelog() {
  return (
    <div className="max-w-3xl mx-auto my-8 bg-white rounded-lg shadow-md p-8">
      <Header />

      <main>
        <Button
          variant="link"
          asChild
          className="h-auto p-0 text-stremlist text-sm"
        >
          <Link to="/">&larr; Back to Home</Link>
        </Button>

        <h2 className="text-xl font-bold text-gray-900 mt-4 mb-1">Changelog</h2>
        <p className="text-sm text-gray-500 mb-6">
          A history of updates and improvements to the Stremlist IMDb Watchlist
          addon.
        </p>

        <div className="space-y-6">
          {VERSIONS.map((v) => (
            <div
              key={v.version}
              className="pb-6 border-b border-gray-100 last:border-b-0"
            >
              <div className="flex items-baseline gap-3 mb-3">
                <span className="text-lg font-bold text-stremlist">
                  {v.version}
                </span>
                <span className="text-sm text-gray-400">{v.date}</span>
              </div>
              <ul className="space-y-2 pl-4">
                {v.changes.map((change, i) => (
                  <li key={i} className="text-sm text-gray-700">
                    <Badge className={`mr-2 ${BADGE_CLASSES[change.type]}`}>
                      {change.label}
                    </Badge>
                    {change.text}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </main>

      <Footer />
    </div>
  );
}
