// A synthetic SensCritique list for the Catalog preview tests. Product IDs
// are far above the real SensCritique range, so the resolver cache rows that
// the tests create never mix with real ones.

export const PREVIEW_PUBLIC_LIST = 990_000_001;
export const PREVIEW_PRIVATE_LIST = 990_000_002;

export interface PreviewProduct {
  id: number;
  type: "movie" | "series";
  /** The SensCritique title. */
  title: string;
  year: number;
  /** What Wikidata links the product to; null: an Unresolved entry. */
  imdbId: string | null;
  /** IMDb's title, for resolved products. */
  englishTitle: string;
  rating: number;
}

/** In Source list order. */
export const PREVIEW_PRODUCTS: PreviewProduct[] = [
  {
    id: 990_000_101,
    type: "movie",
    title: "Le Voyage de Chihiro",
    year: 2001,
    imdbId: "tt0245429",
    englishTitle: "Spirited Away",
    rating: 8.6,
  },
  {
    id: 990_000_102,
    type: "movie",
    title: "Film introuvable",
    year: 1987,
    imdbId: null,
    englishTitle: "",
    rating: 0,
  },
  {
    id: 990_000_103,
    type: "movie",
    title: "Princesse Mononoké",
    year: 1997,
    imdbId: "tt0119698",
    englishTitle: "Princess Mononoke",
    rating: 8.3,
  },
  {
    id: 990_000_104,
    type: "series",
    title: "Série introuvable",
    year: 2004,
    imdbId: null,
    englishTitle: "",
    rating: 0,
  },
];

export const PREVIEW_PRODUCT_IDS = PREVIEW_PRODUCTS.map((product) =>
  String(product.id),
);
