import { describe, expect, it } from "vite-plus/test";
import { SourceUnavailableError } from "../../providers/types";
import { failureMessage, isConnectionReset } from "../connection-reset";

const bunReset = Object.assign(
  new TypeError(
    "ECONNRESET: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
  ),
  { code: "ECONNRESET" },
);
const nodeReset = new TypeError("fetch failed", {
  cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
});
const letterboxd = (cause: unknown) =>
  new SourceUnavailableError(
    "unavailable",
    "Letterboxd could not read this public list",
    { cause },
  );

describe("isConnectionReset", () => {
  it("finds a reset that an adapter error wraps", () => {
    expect(isConnectionReset(bunReset)).toBe(true);
    expect(isConnectionReset(letterboxd(bunReset))).toBe(true);
    expect(isConnectionReset(letterboxd(nodeReset))).toBe(true);
  });

  it("finds no reset behind another failure", () => {
    expect(isConnectionReset(letterboxd(new TypeError("fetch failed")))).toBe(
      false,
    );
    expect(isConnectionReset(letterboxd(undefined))).toBe(false);
  });
});

describe("failureMessage", () => {
  it("names a reset that the message of a wrapping error hides", () => {
    const message = failureMessage(letterboxd(nodeReset));

    expect(message).toBe(
      "Letterboxd could not read this public list (ECONNRESET)",
    );
    expect(isConnectionReset(message)).toBe(true);
  });

  it("keeps other messages as they are", () => {
    expect(failureMessage(bunReset)).toBe(bunReset.message);
    expect(failureMessage(letterboxd(new TypeError("fetch failed")))).toBe(
      "Letterboxd could not read this public list",
    );
    expect(failureMessage("nope")).toBe("Unknown error");
  });
});
