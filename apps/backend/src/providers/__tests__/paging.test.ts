import { describe, expect, it, vi } from "vitest";
import { readPages } from "../paging";

describe("readPages", () => {
  it("is complete when a page says it is the last", async () => {
    const page = vi.fn((cursor: number) =>
      Promise.resolve({
        items: [cursor],
        next: cursor < 3 ? cursor + 1 : null,
      }),
    );
    await expect(readPages({ maxPages: 10, first: 1, page })).resolves.toEqual({
      items: [1, 2, 3],
      complete: true,
    });
    expect(page).toHaveBeenCalledTimes(3);
  });

  it("is incomplete when the page cap stops it", async () => {
    const read = await readPages({
      maxPages: 2,
      first: 0,
      page: (cursor) => Promise.resolve({ items: [cursor], next: cursor + 1 }),
    });
    expect(read).toEqual({ items: [0, 1], complete: false });
  });

  it("stops on a cursor seen before instead of looping", async () => {
    const page = vi.fn((cursor: string | null) =>
      Promise.resolve({ items: [cursor ?? "start"], next: "a" }),
    );
    const read = await readPages({ maxPages: 50, first: null, page });
    expect(read).toEqual({ items: ["start", "a"], complete: false });
    expect(page).toHaveBeenCalledTimes(2);
  });

  it("stops before the next page once maxItems are read", async () => {
    const page = vi.fn((cursor: number, itemsSoFar: number) =>
      Promise.resolve({
        items: [itemsSoFar, itemsSoFar + 1],
        next: cursor + 1,
      }),
    );
    const read = await readPages({
      maxPages: Number.POSITIVE_INFINITY,
      maxItems: 4,
      first: 0,
      page,
    });
    expect(read).toEqual({ items: [0, 1, 2, 3], complete: false });
    expect(page).toHaveBeenCalledTimes(2);
  });

  it("is complete when the last page reaches maxItems exactly", async () => {
    const read = await readPages({
      maxPages: 10,
      maxItems: 2,
      first: 0,
      page: () => Promise.resolve({ items: [1, 2], next: null }),
    });
    expect(read).toEqual({ items: [1, 2], complete: true });
  });
});
