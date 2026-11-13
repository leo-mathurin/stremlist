// A synthetic SensCritique list for the Catalog preview tests. Product IDs
// are far above the real SensCritique range, so the resolver cache rows that
// the tests create never mix with real ones.

export const PREVIEW_PUBLIC_LIST = 990_000_001;
export const PREVIEW_PRIVATE_LIST = 990_000_002;

interface PreviewProduct {
  id: number;
  type: "movie" | "series";
  /** The SensCritique title. */
  title: string;
  year: number;
  /** What Wikidata links the product to; absent: an Unresolved entry. */
  imdb?: { id: string; title: string; rating: number };
}

/** In Source list order. */
export const PREVIEW_PRODUCTS: PreviewProduct[] = [
  {
    id: 990_000_101,
    type: "movie",
    title: "Le Voyage de Chihiro",
    year: 2001,
    imdb: { id: "tt0245429", title: "Spirited Away", rating: 8.6 },
  },
  { id: 990_000_102, type: "movie", title: "Film introuvable", year: 1987 },
  {
    id: 990_000_103,
    type: "movie",
    title: "Princesse Mononoké",
    year: 1997,
    imdb: { id: "tt0119698", title: "Princess Mononoke", rating: 8.3 },
  },
  { id: 990_000_104, type: "series", title: "Série introuvable", year: 2004 },
];

export const PREVIEW_PRODUCT_IDS = PREVIEW_PRODUCTS.map((product) =>
  String(product.id),
);
