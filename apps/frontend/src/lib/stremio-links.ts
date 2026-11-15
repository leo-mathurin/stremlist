/**
 * The `stremio://` deep link that installs an Addon URL, or null when it
 * cannot express it. Stremio opens `stremio://host/path` as
 * `https://host/path`: it always uses HTTPS and drops any port, so a local
 * `http://localhost:5173` Addon URL has no deep link.
 */
export function stremioDeepLink(addonUrl: string): string | null {
  const url = new URL(addonUrl);
  if (url.protocol !== "https:" || url.port !== "") return null;
  return `stremio://${url.host}${url.pathname}${url.search}`;
}
