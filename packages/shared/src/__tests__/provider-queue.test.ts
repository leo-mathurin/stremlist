import { describe, expect, it } from "vite-plus/test";
import {
  formatQueueWait,
  queuedCatalogCopy,
  showsQueueState,
} from "../provider-queue";

describe("queue estimates", () => {
  it("shows the queue state from 3 s", () => {
    expect(showsQueueState(2_999)).toBe(false);
    expect(showsQueueState(3_000)).toBe(true);
  });

  it("rounds to seconds under a minute, then to minutes", () => {
    expect(formatQueueWait(3_000)).toBe("3 s");
    expect(formatQueueWait(12_400)).toBe("12 s");
    expect(formatQueueWait(59_400)).toBe("59 s");
    expect(formatQueueWait(59_600)).toBe("1 min");
    expect(formatQueueWait(89_000)).toBe("1 min");
    expect(formatQueueWait(90_000)).toBe("2 min");
    expect(formatQueueWait(130_000)).toBe("2 min");
  });

  it("words the Stremio card without a dash", () => {
    const copy = queuedCatalogCopy("letterboxd");
    expect(copy).toEqual({
      title: "Your Letterboxd list is on its way",
      description:
        "Letterboxd is busy right now. Stremlist is reading your list and it will show here in a few minutes.",
    });
    expect(JSON.stringify(copy)).not.toMatch(/[–—]/u);
  });
});
