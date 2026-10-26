import { SITE } from "./site";

type LegalBlock = string | { label: string; text: string }[];
interface LegalSection {
  id: string;
  label: string;
  clauses: { title: string; blocks: LegalBlock[] }[];
}
export const LEGAL_UPDATED = "2026-10-06";
export const LEGAL_SECTIONS: LegalSection[] = [
  {
    id: "terms",
    label: "Terms and Conditions",
    clauses: [
      {
        title: "1. Introduction",
        blocks: [
          'Welcome to Stremlist ("Service"), a personal project that shows watchlists and lists kept on other services (IMDb, Trakt, Simkl, MDBList, JustWatch and SensCritique, the "Providers") as catalogs in Stremio. By accessing or using the Service, you agree to be bound by these Terms and Conditions.',
        ],
      },
      {
        title: "2. Description of Service",
        blocks: [
          "Stremlist is a free addon for Stremio. It reads the lists that you choose, either public lists that you add by link or lists of a Provider account that you connect, formats them for Stremio, and keeps a cached copy to provide fast catalogs.",
        ],
      },
      {
        title: "3. Use of the Service",
        blocks: [
          "You may use the Service with lists that you are allowed to view. When you connect a Provider account, you allow Stremlist to read your lists on that Provider and, if you turn on Actions, to make the changes that you ask for from Stremio (such as adding a title to your watchlist). You can disconnect at any time on the configure page.",
        ],
      },
      {
        title: "4. Limitations",
        blocks: [
          'The Service is provided "as is" and "as available" without any warranties of any kind. The Service developer is not responsible for any issues related to the functionality of Stremio or of a Provider, or any content accessed through these platforms.',
        ],
      },
      {
        title: "5. Third-Party Services",
        blocks: [
          "Stremlist interacts with third-party services (Stremio and the Providers). Your use of these services is subject to their respective terms and conditions and privacy policies. Stremlist is not affiliated with, endorsed by, or sponsored by Stremio or any Provider.",
        ],
      },
      {
        title: "6. Modifications to Service",
        blocks: [
          "The Service developer reserves the right to modify or discontinue, temporarily or permanently, the Service with or without notice.",
        ],
      },
      {
        title: "7. Contact",
        blocks: [
          `If you have any questions about these Terms, please contact ${SITE.contact}.`,
        ],
      },
    ],
  },
  {
    id: "privacy",
    label: "Privacy Policy",
    clauses: [
      {
        title: "1. Information Collection",
        blocks: [
          "Stremlist collects only what it needs to run the Service: the lists that you add (their Provider and link or ID), your settings, and for each Provider account that you connect, its username and access tokens. We do not ask for names or passwords. Your email address is stored only if you subscribe to the newsletter.",
        ],
      },
      {
        title: "2. Use of Information",
        blocks: [
          "Your lists and access tokens are used only to read your lists from the Providers, convert them for Stremio, and perform the Actions that you ask for. They are not used for any other purpose and are not shared with any third parties.",
        ],
      },
      {
        title: "3. Data Storage with Supabase",
        blocks: [
          "Stremlist stores data with Supabase (a cloud database built on PostgreSQL) and Cloudflare R2 (cloud storage). We store the following:",
          [
            {
              label: "Account records:",
              text: "a random Account ID (the secret part of your Addon URL), the IMDb user ID of installs made before Account IDs existed, creation date, last activity and refresh times, your lists and their settings (titles, sort, filters), your RPDB key if you add one, and your Actions settings.",
            },
            {
              label: "Connections:",
              text: "the username and OAuth access tokens of each Provider account that you connect. Tokens are encrypted before they are stored. Disconnecting a Provider deletes them.",
            },
            {
              label: "List cache:",
              text: 'a cached copy of your lists (titles, IDs, metadata). It is refreshed periodically (roughly every 30 minutes) and whenever you use "Refresh now", and it keeps your catalogs available if a Provider is temporarily down. Each refresh overwrites the previous copy rather than keeping a history.',
            },
          ],
          "Your Addon URL gives access to your Stremlist: anyone who has it can view and change your lists, so keep it private. We do not store passwords, or any data beyond what is needed to provide the Service.",
        ],
      },
      {
        title: "4. Cookies and Tracking",
        blocks: [
          "The Stremlist website does not use cookies or any tracking technologies to collect user information.",
        ],
      },
      {
        title: "5. Email Communications",
        blocks: [
          "Stremlist sends emails only to newsletter subscribers, about new features and service announcements. You can unsubscribe at any time from any newsletter email.",
        ],
      },
      {
        title: "6. Third-Party Services",
        blocks: [
          "Stremlist interacts with the Providers to read your lists and, when you ask for it, to perform Actions. We do not control and are not responsible for the privacy practices of the Providers. We encourage you to review their privacy policies.",
        ],
      },
      {
        title: "7. Data Security",
        blocks: [
          "While we implement reasonable security measures, no method of transmission over the Internet is 100% secure. We cannot guarantee absolute security of your information.",
        ],
      },
      {
        title: "8. Children's Privacy",
        blocks: [
          "The Service is not directed to children under 13. We do not knowingly collect personal information from children under 13.",
        ],
      },
      {
        title: "9. Changes to This Privacy Policy",
        blocks: [
          "We may update our Privacy Policy from time to time. We will notify you of any changes by posting the new Privacy Policy on this page.",
        ],
      },
      {
        title: "10. Contact Us",
        blocks: [
          `If you have any questions about this Privacy Policy, please contact us at ${SITE.contact}.`,
        ],
      },
    ],
  },
];
