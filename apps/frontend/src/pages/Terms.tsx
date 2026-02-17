import { Link } from "react-router";
import Header from "../components/Header";

export default function Terms() {
  return (
    <div className="max-w-3xl mx-auto my-8 bg-white rounded-lg shadow-md p-8">
      <Header />

      <main className="space-y-8">
        <Link to="/" className="text-accent hover:underline text-sm">
          &larr; Back to Home
        </Link>

        {/* Terms and Conditions */}
        <section>
          <h2 className="text-xl font-bold text-gray-900 pb-2 mb-4 border-b-2 border-imdb">
            Terms and Conditions
          </h2>
          <p className="text-sm text-gray-500 mb-4">
            Last updated: February 17, 2025
          </p>

          <div className="space-y-4 text-sm text-gray-700">
            <div>
              <h3 className="font-semibold text-gray-800 mb-1">
                1. Introduction
              </h3>
              <p>
                Welcome to Stremlist ("Service"), a personal project that
                creates a connection between public IMDb watchlists and the
                Stremio streaming platform. By accessing or using the Service,
                you agree to be bound by these Terms and Conditions.
              </p>
            </div>

            <div>
              <h3 className="font-semibold text-gray-800 mb-1">
                2. Description of Service
              </h3>
              <p>
                Stremlist is a free addon for Stremio that allows users to
                access their public IMDb watchlists directly within the Stremio
                application. The Service processes publicly available IMDb
                watchlist data, formats it for Stremio, and stores it in
                Supabase (a cloud database) to provide fast catalog access and
                sync capabilities.
              </p>
            </div>

            <div>
              <h3 className="font-semibold text-gray-800 mb-1">
                3. Use of the Service
              </h3>
              <p>
                You may use this Service only if you have a public IMDb
                watchlist and agree to provide your public IMDb user ID. The
                Service only accesses publicly available data that you have
                explicitly made public through IMDb's platform.
              </p>
            </div>

            <div>
              <h3 className="font-semibold text-gray-800 mb-1">
                4. Limitations
              </h3>
              <p>
                The Service is provided "as is" and "as available" without any
                warranties of any kind. The Service developer is not responsible
                for any issues related to IMDb or Stremio functionality or any
                content accessed through these platforms.
              </p>
            </div>

            <div>
              <h3 className="font-semibold text-gray-800 mb-1">
                5. Third-Party Services
              </h3>
              <p>
                Stremlist interacts with third-party services (IMDb and
                Stremio). Your use of these services is subject to their
                respective terms and conditions and privacy policies. Stremlist
                is not affiliated with, endorsed by, or sponsored by IMDb or
                Stremio.
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
                  href="mailto:lelemathrin69@gmail.com"
                  className="text-accent hover:underline"
                >
                  lelemathrin69@gmail.com
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
            Last updated: February 17, 2025
          </p>

          <div className="space-y-4 text-sm text-gray-700">
            <div>
              <h3 className="font-semibold text-gray-800 mb-1">
                1. Information Collection
              </h3>
              <p>
                Stremlist collects only the IMDb user ID that you explicitly
                provide to use the Service. This public ID is used to fetch your
                public IMDb watchlist data. We do not collect names, email
                addresses, or any other personally identifiable information.
              </p>
            </div>

            <div>
              <h3 className="font-semibold text-gray-800 mb-1">
                2. Use of Information
              </h3>
              <p>
                The IMDb user ID you provide is used solely to retrieve your
                public watchlist data from IMDb and convert it into a format
                usable by Stremio. Your ID is not used for any other purpose and
                is not shared with any third parties.
              </p>
            </div>

            <div>
              <h3 className="font-semibold text-gray-800 mb-1">
                3. Data Storage with Supabase
              </h3>
              <p>
                Stremlist stores data using Supabase, a secure cloud database
                platform built on PostgreSQL. We store the following:
              </p>
              <ul className="list-disc list-inside mt-2 space-y-1 ml-2">
                <li>
                  <strong>User records</strong> — Your IMDb user ID, account
                  creation date, last activity timestamp, last sync time, your
                  chosen sort preference (e.g., by date added or title), and
                  whether your account is active.
                </li>
                <li>
                  <strong>Watchlist cache</strong> — A cached copy of your
                  public IMDb watchlist (titles, IDs, metadata) linked to your
                  IMDb user ID. This cache is regularly updated by our sync
                  system so your Stremio catalog stays current. Cached data is
                  overwritten on each sync rather than retained indefinitely.
                </li>
              </ul>
              <p className="mt-2">
                Data is stored in Supabase&apos;s hosted infrastructure with
                standard security measures. We do not store passwords, or any
                data beyond what is needed to provide the Service.
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
                Stremlist does not send emails to users. The only email
                communications are system notifications sent to the
                administrator's email address regarding system operations and
                deployment status.
              </p>
            </div>

            <div>
              <h3 className="font-semibold text-gray-800 mb-1">
                6. Third-Party Services
              </h3>
              <p>
                Stremlist interacts with IMDb to access your public watchlist
                data. We do not control and are not responsible for the privacy
                practices of IMDb. We encourage you to review IMDb's privacy
                policy.
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
                  href="mailto:lelemathrin69@gmail.com"
                  className="text-accent hover:underline"
                >
                  lelemathrin69@gmail.com
                </a>
                .
              </p>
            </div>
          </div>
        </section>
      </main>

      <footer className="mt-8 pt-6 border-t border-gray-200 text-center text-sm text-gray-500 space-y-2">
        <p>
          <Link to="/" className="text-accent hover:underline">
            Return to Home
          </Link>
        </p>
        <p>&copy; 2025 - IMDb Watchlist for Stremio</p>
      </footer>
    </div>
  );
}
