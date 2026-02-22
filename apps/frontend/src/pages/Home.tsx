import { useState, useEffect } from "react";
import { Link } from "react-router";
import { motion } from "motion/react";
import Header from "../components/Header";
import SetupForm from "../components/SetupForm";
import Footer from "../components/Footer";
import { api } from "../lib/api";
import { Badge } from "@/components/ui/badge";

export default function Home() {
  const [userCount, setUserCount] = useState<number | null>(null);

  useEffect(() => {
    api.stats
      .$get()
      .then((r) => r.json())
      .then((data) => {
        if (data.activeUsers !== undefined) setUserCount(data.activeUsers);
      })
      .catch(() => {});
  }, []);

  return (
    <div className="max-w-3xl mx-auto my-8 bg-white rounded-lg shadow-md p-8">
      <Header />

      <main className="space-y-8">
        <section className="text-center">
          <h2 className="text-2xl font-bold text-gray-900 mb-2">
            Connect IMDb to Stremio
          </h2>
          {userCount !== null ? (
            <motion.p
              className="text-lg text-gray-500"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: "spring", stiffness: 300, damping: 25 }}
            >
              <span className="text-blue-600">
                Powering {userCount.toLocaleString()} watchlists so far...
              </span>
            </motion.p>
          ) : (
            <div className="flex items-center justify-center gap-0.5 h-7"></div>
          )}
          <p className="text-gray-600">
            Stremlist brings your IMDb watchlists directly into Stremio.
          </p>
          <p className="text-gray-600">
            Enter your IMDb User ID below to get started.
          </p>
        </section>

        <SetupForm />

        <section>
          <h2 className="text-xl font-bold text-gray-900 mb-4">How it works</h2>
          <div className="grid gap-4 sm:grid-cols-3">
            {[
              {
                step: 1,
                title: "Enter your IMDb ID",
                desc: "Provide your IMDb User ID to connect your watchlists",
              },
              {
                step: 2,
                title: "Install in Stremio",
                desc: "Choose your preferred installation method",
              },
              {
                step: 3,
                title: "Enjoy your watchlists",
                desc: "Access one or more IMDb watchlists directly in Stremio",
              },
            ].map((item) => (
              <div
                key={item.step}
                className="border-l-4 border-imdb bg-gray-50 rounded-r-lg p-4"
              >
                <div className="flex items-start gap-3">
                  <Badge className="shrink-0 w-8 h-8 rounded-full bg-imdb text-black font-bold text-sm border-0 flex items-center justify-center">
                    {item.step}
                  </Badge>
                  <div>
                    <h3 className="font-semibold text-gray-800">
                      {item.title}
                    </h3>
                    <p className="text-sm text-gray-600">{item.desc}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="border-l-4 border-imdb bg-gray-50 rounded-r-lg p-5">
          <h2 className="text-lg font-bold text-gray-900 mb-2">
            Where to find your watchlists in Stremio
          </h2>
          <p className="text-sm text-gray-600 mb-2">
            After installation, you can access your IMDb watchlists in two ways:
          </p>
          <ul className="list-disc list-inside text-sm text-gray-600 space-y-1 mb-3">
            <li>
              <strong>Home page:</strong> Each watchlist appears as its own
              catalog on the Stremio home page
            </li>
            <li>
              <strong>Discover section:</strong> Find your watchlists as filters
              under the "Popular" category
            </li>
          </ul>
          <div className="bg-amber-50 border border-amber-200 rounded-md p-3 text-sm text-amber-800">
            <strong>⚠️ Note:</strong> Newly installed add-ons appear last by
            default. You may need to scroll down to find your watchlists. To
            reorder, check out this{" "}
            <a
              href="https://addon-manager.dontwanttos.top/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-stremlist underline"
            >
              addon manager utility
            </a>
            .
          </div>
        </section>

        <section className="border-l-4 border-stremlist bg-gray-50 rounded-r-lg p-5">
          <h2 className="text-lg font-bold text-gray-900 mb-3">
            What happens behind the scenes
          </h2>
          <div className="space-y-3">
            {[
              "When you add this addon to Stremio, it securely retrieves your public IMDb watchlist data",
              "Your watchlists are converted into a format that Stremio can understand and display",
              "The addon automatically checks for updates to your watchlists every 6-12 hours",
              "Everything happens in real-time \u2013 no data is stored permanently, protecting your privacy",
            ].map((text, i) => (
              <div key={i} className="flex items-start gap-3">
                <Badge className="shrink-0 w-7 h-7 rounded-full bg-stremlist text-white font-bold text-xs border-0 flex items-center justify-center">
                  {i + 1}
                </Badge>
                <p className="text-sm text-gray-600">{text}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="border-l-4 border-stremlist bg-gray-50 rounded-r-lg p-5">
          <h2 className="text-lg font-bold text-gray-900 mb-3">Features</h2>
          <h3 className="font-semibold text-gray-800 mb-1">
            Multiple Watchlists
          </h3>
          <p className="text-sm text-gray-600 mb-3">
            Follow watchlists from different IMDb users and display them all as
            separate catalogs in Stremio. Great for combining your own watchlist
            with a friend's or a curated list.
          </p>
          <h3 className="font-semibold text-gray-800 mb-1">
            Customizable Sorting
          </h3>
          <p className="text-sm text-gray-600 mb-2">
            Sort each watchlist independently! After installing the addon:
          </p>
          <ol className="list-decimal list-inside text-sm text-gray-600 space-y-1">
            <li>
              Visit the{" "}
              <Link to="/configure" className="text-stremlist underline">
                configure page
              </Link>
            </li>
            <li>
              Choose a sorting method per watchlist:
              <ul className="list-disc list-inside ml-4 mt-1 space-y-0.5">
                <li>Date Added (Oldest or Newest first) - (IMDb Order)</li>
                <li>Title (A-Z or Z-A)</li>
                <li>Release Year (newest or oldest first)</li>
                <li>Rating (highest or lowest first)</li>
              </ul>
            </li>
            <li>
              Each watchlist will instantly adjust to its preferred order
            </li>
          </ol>
          <h3 className="font-semibold text-gray-800 mt-3 mb-1">
            RPDB Posters
          </h3>
          <p className="text-sm text-gray-600">
            Add your{" "}
            <a
              href="https://ratingposterdb.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-stremlist underline"
            >
              Rating Poster Database
            </a>{" "}
            API key to replace default posters with rating-overlay posters
            showing IMDb, Trakt, or other scores right on the cover art.
          </p>
        </section>

        <section className="border-l-4 border-orange-400 bg-gray-50 rounded-r-lg p-5">
          <h2 className="text-lg font-bold text-gray-900 mb-2">
            Troubleshooting
          </h2>
          <p className="text-sm text-gray-600 mb-2">
            If you experience any issues:
          </p>
          <ul className="list-disc list-inside text-sm text-gray-600 space-y-1">
            <li>Make sure your IMDb watchlists are set to public</li>
            <li>Try using Stremio Web instead of Stremio Desktop</li>
            <li>
              If Stremio shows "Failed to fetch," try restarting Stremio after
              adding the addon
            </li>
            <li>
              Ensure your IMDb ID starts with "ur" and is entered correctly
            </li>
          </ul>
        </section>
      </main>

      <Footer />
    </div>
  );
}
