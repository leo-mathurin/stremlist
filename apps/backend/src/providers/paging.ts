import type { PagedRead } from "./types";

/** One page of a paginated read, and the cursor of the next one (null: last). */
interface Page<T, C> {
  items: T[];
  next: C | null;
}

interface ReadPagesOptions<T, C> {
  /** Most pages read; reaching it leaves the read incomplete. */
  maxPages: number;
  /** Stop before the next page once this many items are read. */
  maxItems?: number;
  /** The cursor of the first page (an offset, a page number, null…). */
  first: C;
  /** Read the page at `cursor`, knowing how many items came before it. */
  page(cursor: C, itemsSoFar: number): Promise<Page<T, C>>;
}

/**
 * Read every page of a paginated Source list. The read is complete only when
 * a page says it is the last; a page or item cap, or a cursor seen before
 * (which would loop), stops it with `complete: false` (ADR 0007).
 */
export async function readPages<T, C>(
  options: ReadPagesOptions<T, C>,
): Promise<PagedRead<T>> {
  const items: T[] = [];
  const seen = new Set<C>([options.first]);
  let cursor = options.first;
  for (let index = 0; index < options.maxPages; index++) {
    if (options.maxItems !== undefined && items.length >= options.maxItems) {
      break;
    }
    const { items: batch, next } = await options.page(cursor, items.length);
    items.push(...batch);
    if (next === null) return { items, complete: true };
    if (seen.has(next)) break;
    seen.add(next);
    cursor = next;
  }
  return { items, complete: false };
}
