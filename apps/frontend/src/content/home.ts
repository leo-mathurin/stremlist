export const HOME = {
  title: "Your lists, all in Stremio.",
  intro:
    "Paste a link to any watchlist or list, or connect your account. Each one shows up as its own row in Stremio.",
  providersTitle: "Many sites, one addon",
  providersLead:
    "Paste a link from any of these sites, or connect your Trakt, Simkl or MDBList account.",
  pasteTitle: "Paste a link",
  pasteBody:
    "Any public watchlist or list from a supported site. Stremlist finds the site and the list for you.",
  connectTitle: "Connect an account",
  connectBody:
    "Add your private lists from Trakt, Simkl or MDBList, and use Actions in Stremio.",
  previewTitle: "Every List is a row in Stremio",
  previewLead:
    "Stremlist reads each List and shows it in Stremio as its own catalog, next to your other addons.",
  stepsTitle: "How it works",
  featuresTitle: "Features",
  findTitle: "Where to find your Lists",
  findLead:
    "Once you install Stremlist, your Lists show in two places in Stremio.",
  addonManager: "New addons show last. To move Stremlist up, use",
  troubleshootingTitle: "Troubleshooting",
  troubleshootingLead:
    "Something looks wrong? Find the problem to see the fix.",
  disclaimer:
    "Stremlist only organizes your lists. It does not host or link to any video. Read the",
};

export const STEPS = [
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

export const TROUBLESHOOTING = [
  [
    "My Lists are empty",
    "Make sure your lists are public, or connect the account that owns them.",
  ],
  [
    "Stremio still shows my old Lists",
    "Reinstall Stremlist so Stremio reads the new catalogs.",
  ],
  ['Stremio shows "Failed to fetch"', "Restart Stremio, or try Stremio Web."],
  [
    "I lost my configure page",
    "Open it from the Stremlist addon in Stremio, or paste your Addon URL above.",
  ],
] as const;

export const FIND_PLACES = [
  ["Home", "Each List is its own row."],
  ["Discover", "Your Lists show as catalog filters."],
] as const;

export const FEATURES = [
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
