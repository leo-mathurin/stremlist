import { PROVIDER_NAMES, SITE } from "./site";

type LegalBlock = string | { label: string; text: string }[];
interface LegalSection {
  id: string;
  label: string;
  clauses: { title: string; blocks: LegalBlock[] }[];
}
export const LEGAL_UPDATED = "2026-11-09";
export const LEGAL_SECTIONS: LegalSection[] = [
  {
    id: "terms",
    label: "Terms and Conditions",
    clauses: [
      {
        title: "1. Introduction",
        blocks: [
          `Welcome to Stremlist ("Service"), a personal project that shows watchlists and lists kept on other services (${PROVIDER_NAMES}, the "Providers") as catalogs in Stremio. By accessing or using the Service, you agree to be bound by these Terms and Conditions.`,
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
          "Stremlist collects only what it needs to run the Service: the lists that you add (their Provider and link or ID), your settings, and for each Provider account that you connect, its username and access tokens. We do not ask for your name, email address or passwords to use the Service. Your email address is stored only if you subscribe to the newsletter.",
        ],
      },
      {
        title: "2. Use of Information",
        blocks: [
          "Your lists and access tokens are used only to read your lists from the Providers, convert them for Stremio, and perform the Actions that you ask for. We do not sell your data or use it for ads. We send data only to the services in section 6, and only what each one needs to do its part.",
        ],
      },
      {
        title: "3. Data Storage",
        blocks: [
          "Stremlist stores data with Supabase (a PostgreSQL database) and Cloudflare R2 (file storage). We store the following:",
          [
            {
              label: "Account records:",
              text: "a random Account ID (the secret part of your Addon URL), the IMDb user ID of installs made before Account IDs existed, creation date, last activity and refresh times, your lists and their settings (titles, sort, filters), your RPDB key if you add one, and your Actions and New titles settings.",
            },
            {
              label: "Connections:",
              text: "the username and OAuth tokens of each Provider account that you connect. Tokens are encrypted with AES-256-GCM before they are stored. When you disconnect a Provider, we ask it to cancel the tokens, then delete them and the data of the private lists that it gave access to.",
            },
            {
              label: "List cache:",
              text: 'a cached copy of your lists (titles, IDs, metadata). It refreshes about every 30 minutes and when you use "Refresh now", and it keeps your catalogs available if a Provider is down. Each refresh makes a new copy. Old copies are deleted automatically after about 30 days.',
            },
            {
              label: "New titles history:",
              text: "for each list, the titles that Stremlist has seen and the dates when they were added to or removed from the list. This history makes the New titles catalog work, and Stremlist keeps it even when that catalog is off. A removed title is forgotten 180 days after it left the list. The history of a list that Stremlist no longer reads is deleted after about 30 days.",
            },
            {
              label: "Letterboxd request log:",
              text: "when Stremlist reads a Letterboxd page, it can log the request to find problems: the page address, the response status and timing, and for a failed request the start of the response. All failed requests are logged, and about 1 in 100 successful ones. A page address can contain a Letterboxd username. Share link codes are hidden. The log has no Account ID or IP address, and each entry is deleted after 30 days.",
            },
            {
              label: "Server logs:",
              text: "request and error logs at Vercel can contain an Account ID, because it is part of each Addon URL that Stremio calls. When a newsletter signup fails, an error log can contain the email address. Vercel keeps these logs for a limited time.",
            },
          ],
          "Your Addon URL gives access to your Stremlist: anyone who has it can view and change your lists, so keep it private. We do not store passwords.",
        ],
      },
      {
        title: "4. Cookies and Analytics",
        blocks: [
          "The Stremlist website does not set cookies. It uses Vercel Web Analytics to count page visits, which does not use cookies. Analytics gets the page address without its query or fragment, so it never gets your Account ID. Your browser keeps a few items for this site: a one-time key and your Account ID while you connect a Provider, your unsaved changes and a pasted link during that time, the ID of an Account you just created, and the state of your last install, so we can tell you when to reinstall. They stay in your browser.",
        ],
      },
      {
        title: "5. Email Communications",
        blocks: [
          "Stremlist sends emails only to newsletter subscribers, about new features and service announcements. Your email address is kept by Resend, our email service. You can unsubscribe at any time from any newsletter email.",
        ],
      },
      {
        title: "6. Third-Party Services",
        blocks: [
          "These services receive data to run Stremlist:",
          [
            {
              label: "Hosting and storage:",
              text: "Vercel hosts the website and the addon and counts page visits. Supabase and Cloudflare R2 store the data in section 3.",
            },
            {
              label: "Providers:",
              text: `${PROVIDER_NAMES} receive the links, usernames or tokens that Stremlist needs to read your lists, and the Actions that you ask for.`,
            },
            {
              label: "Title data:",
              text: "TMDB, Wikidata, JustWatch and Cinemeta (from Stremio) receive title IDs only, to match titles and fill in missing details.",
            },
            {
              label: "Email:",
              text: "Resend receives your email address if you subscribe to the newsletter.",
            },
            {
              label: "Posters:",
              text: "if you add an RPDB key, Stremio and the configure page send your key and title IDs to RPDB to load poster images. The configure page preview also loads posters from Stremio's image service.",
            },
          ],
          "We do not control and are not responsible for the privacy practices of these services. We encourage you to review their privacy policies.",
        ],
      },
      {
        title: "7. Your Choices",
        blocks: [
          `You can remove lists and disconnect Providers at any time on the configure page. To delete your Account and all its data, email us at ${SITE.contact}.`,
        ],
      },
      {
        title: "8. Data Security",
        blocks: [
          "While we implement reasonable security measures, no method of transmission over the Internet is 100% secure. We cannot guarantee absolute security of your information.",
        ],
      },
      {
        title: "9. Children's Privacy",
        blocks: [
          "The Service is not directed to children under 13. We do not knowingly collect personal information from children under 13.",
        ],
      },
      {
        title: "10. Changes to This Privacy Policy",
        blocks: [
          "We may update our Privacy Policy from time to time. We will notify you of any changes by posting the new Privacy Policy on this page.",
        ],
      },
      {
        title: "11. Contact Us",
        blocks: [
          `If you have any questions about this Privacy Policy, please contact us at ${SITE.contact}.`,
        ],
      },
    ],
  },
];
