export interface CatalogExtras {
  skip: number;
}

// Stremio packs catalog extras into a path segment like `skip=100.json` or
// `genre=Action&skip=100.json`. Parse it as a URL-encoded key=value pair list.
// Unknown/invalid keys are silently ignored so we never reject a catalog
// request because of malformed extras.
export function parseCatalogExtras(raw: string | undefined): CatalogExtras {
  const out: CatalogExtras = { skip: 0 };
  if (!raw) return out;

  const cleaned = raw.replace(/\.json$/u, "");
  for (const part of cleaned.split("&")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = decodeURIComponent(part.slice(0, eq));
    const value = decodeURIComponent(part.slice(eq + 1));
    if (key === "skip") {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n) && n >= 0) out.skip = n;
    }
  }
  return out;
}
