import { Link } from "react-router";
import Header from "../components/Header";
import { useSEO } from "../hooks/useSEO";

export default function Terms() {
  useSEO({
    title: "Terms & Privacy - Stremlist",
    description:
      "Terms of service and privacy policy for Stremlist, the free Stremio addon for your watchlists and lists.",
    canonical: "https://stremlist.com/terms",
  });
  return (
    <div className="max-w-3xl mx-auto my-8 bg-white rounded-lg shadow-md p-8">
      <Header />

      <main className="space-y-8">
        <Link to="/" className="text-stremlist hover:underline text-sm">
          &larr; Back to Home
        </Link>

        {/* Terms and Conditions */}
        <section>
          <h2 className="text-xl font-bold text-gray-900 pb-2 mb-4 border-b-2 border-imdb">
            Terms and Conditions
          </h2>
          <p className="text-sm text-gray-500 mb-4">
            Last updated: October 6, 2026
          </p>

          <div className="space-y-4 text-sm text-gray-700">
            <div>
              <h3 className="font-semibold text-gray-800 mb-1">
                1. Introduction
              </h3>
              <p>
                Welcome to Stremlist ("Service"), a personal project that shows
                watchlists and lists kept on other services (IMDb, Trakt, Simkl,
                MDBList, JustWatch and SensCritique, the "Providers") as
                catalogs in Stremio. By accessing or using the Service, you
                agree to be bound by these Terms and Conditions.
              </p>
            </div>

            <div>
              <h3 className="font-semibold text-gray-800 mb-1">
                2. Description of Service
              </h3>
              <p>
                Stremlist is a free addon for Stremio. It reads the lists that
                you choose, either public lists that you add by link or lists of
                a Provider account that you connect, formats them for Stremio,
                and keeps a cached copy to provide fast catalogs.
              </p>
            </div>

            <div>
              <h3 className="font-semibold text-gray-800 mb-1">
                3. Use of the Service
              </h3>
              <p>
                You may use the Service with lists that you are allowed to view.
                When you connect a Provider account, you allow Stremlist to read
                your lists on that Provider and, if you turn on Actions, to make
                the changes that you ask for from Stremio (such as adding a
                title to your watchlist). You can disconnect at any time on the
                configure page.
              </p>
            </div>

            <div>
              <h3 className="font-semibold text-gray-800 mb-1">
                4. Limitations
              </h3>
              <p>
                The Service is provided "as is" and "as available" without any
                warranties of any kind. The Service developer is not responsible
                for any issues related to the functionality of Stremio or of a
                Provider, or any content accessed through these platforms.
              </p>
            </div>

            <div>
              <h3 className="font-semibold text-gray-800 mb-1">
                5. Third-Party Services
              </h3>
              <p>
                Stremlist interacts with third-party services (Stremio and the
                Providers). Your use of these services is subject to their
                respective terms and conditions and privacy policies. Stremlist
                is not affiliated with, endorsed by, or sponsored by Stremio or
                any Provider.
              </p>
            </div>

            <div>
              <h3 className="font-semibold text-gray-800 mb-1">
                6. Modifications to Service
              </h3>
              <p>
                The Service developer reserves the right to modify or
                discontinue, temporarily or permanently, the Service with or
                without notice.
              </p>
            </div>

            <div>
              <h3 className="font-semibold text-gray-800 mb-1">7. Contact</h3>
              <p>
                If you have any questions about these Terms, please contact{" "}
                <a
                  href="mailto:me@leomathurin.com"
                  className="text-stremlist hover:underline"
                >
                  me@leomathurin.com
                </a>
                .
              </p>
            </div>
          </div>
        </section>

        {/* Privacy Policy */}
        <section>
          <h2 className="text-xl font-bold text-gray-900 pb-2 mb-4 border-b-2 border-imdb">
            Privacy Policy
          </h2>
          <p className="text-sm text-gray-500 mb-4">
            Last updated: October 6, 2026
          </p>

          <div className="space-y-4 text-sm text-gray-700">
            <div>
              <h3 className="font-semibold text-gray-800 mb-1">
                1. Information Collection
              </h3>
              <p>
                Stremlist collects only what it needs to run the Service: the
                lists that you add (their Provider and link or ID), your
                settings, and for each Provider account that you connect, its
                username and access tokens. We do not ask for names or
                passwords. Your email address is stored only if you subscribe to
                the newsletter.
              </p>
            </div>

            <div>
              <h3 className="font-semibold text-gray-800 mb-1">
                2. Use of Information
              </h3>
              <p>
                Your lists and access tokens are used only to read your lists
                from the Providers, convert them for Stremio, and perform the
                Actions that you ask for. They are not used for any other
                purpose and are not shared with any third parties.
              </p>
            </div>

            <div>
              <h3 className="font-semibold text-gray-800 mb-1">
                3. Data Storage with Supabase
              </h3>
              <p>
                Stremlist stores data with Supabase (a cloud database built on
                PostgreSQL) and Cloudflare R2 (cloud storage). We store the
                following:
              </p>
              <ul className="list-disc list-inside mt-2 space-y-1 ml-2">
                <li>
                  <strong>Account records:</strong> a random Account ID (the
                  secret part of your Addon URL), the IMDb user ID of installs
                  made before Account IDs existed, creation date, last activity
                  and refresh times, your lists and their settings (titles,
                  sort, filters), your RPDB key if you add one, and your Actions
                  settings.
                </li>
                <li>
                  <strong>Connections:</strong> the username and OAuth access
                  tokens of each Provider account that you connect. Tokens are
                  encrypted before they are stored. Disconnecting a Provider
                  deletes them.
                </li>
                <li>
                  <strong>List cache:</strong> a cached copy of your lists
                  (titles, IDs, metadata). It is refreshed periodically (roughly
                  every 30 minutes) and whenever you use "Refresh now", and it
                  keeps your catalogs available if a Provider is temporarily
                  down. Each refresh overwrites the previous copy rather than
                  keeping a history.
                </li>
              </ul>
              <p className="mt-2">
                Your Addon URL gives access to your Stremlist: anyone who has it
                can view and change your lists, so keep it private. We do not
                store passwords, or any data beyond what is needed to provide
                the Service.
              </p>
            </div>

            <div>
              <h3 className="font-semibold text-gray-800 mb-1">
                4. Cookies and Tracking
              </h3>
              <p>
                The Stremlist website does not use cookies or any tracking
                technologies to collect user information.
              </p>
            </div>

            <div>
              <h3 className="font-semibold text-gray-800 mb-1">
                5. Email Communications
              </h3>
              <p>
                Stremlist sends emails only to newsletter subscribers, about new
                features and service announcements. You can unsubscribe at any
                time from any newsletter email.
              </p>
            </div>

            <div>
              <h3 className="font-semibold text-gray-800 mb-1">
                6. Third-Party Services
              </h3>
              <p>
                Stremlist interacts with the Providers to read your lists and,
                when you ask for it, to perform Actions. We do not control and
                are not responsible for the privacy practices of the Providers.
                We encourage you to review their privacy policies.
              </p>
            </div>

            <div>
              <h3 className="font-semibold text-gray-800 mb-1">
                7. Data Security
              </h3>
              <p>
                While we implement reasonable security measures, no method of
                transmission over the Internet is 100% secure. We cannot
                guarantee absolute security of your information.
              </p>
            </div>

            <div>
              <h3 className="font-semibold text-gray-800 mb-1">
                8. Children's Privacy
              </h3>
              <p>
                The Service is not directed to children under 13. We do not
                knowingly collect personal information from children under 13.
              </p>
            </div>

            <div>
              <h3 className="font-semibold text-gray-800 mb-1">
                9. Changes to This Privacy Policy
              </h3>
              <p>
                We may update our Privacy Policy from time to time. We will
                notify you of any changes by posting the new Privacy Policy on
                this page.
              </p>
            </div>

            <div>
              <h3 className="font-semibold text-gray-800 mb-1">
                10. Contact Us
              </h3>
              <p>
                If you have any questions about this Privacy Policy, please
                contact us at{" "}
                <a
                  href="mailto:me@leomathurin.com"
                  className="text-stremlist hover:underline"
                >
                  me@leomathurin.com
                </a>
                .
              </p>
            </div>
          </div>
        </section>
      </main>

      <footer className="mt-8 pt-6 border-t border-gray-200 text-center text-sm text-gray-500 space-y-2">
        <p>
          <Link to="/" className="text-stremlist hover:underline">
            Return to Home
          </Link>
        </p>
        <p>&copy; {new Date().getFullYear()} Stremlist</p>
      </footer>
    </div>
  );
}
