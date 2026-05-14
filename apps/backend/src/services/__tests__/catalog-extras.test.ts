import { describe, expect, it } from "vitest";
import { parseCatalogExtras } from "../catalog-extras";

describe("parseCatalogExtras", () => {
  it("returns skip=0 for undefined input", () => {
    expect(parseCatalogExtras(undefined)).toEqual({ skip: 0 });
  });

  it("returns skip=0 for empty string", () => {
    expect(parseCatalogExtras("")).toEqual({ skip: 0 });
  });

  it("parses a single skip value with .json suffix", () => {
    expect(parseCatalogExtras("skip=100.json")).toEqual({ skip: 100 });
  });

  it("parses skip without .json suffix", () => {
    expect(parseCatalogExtras("skip=200")).toEqual({ skip: 200 });
  });

  it("parses skip alongside other (unknown) extras", () => {
    expect(parseCatalogExtras("genre=Action&skip=300.json")).toEqual({
      skip: 300,
    });
    expect(parseCatalogExtras("skip=100&search=batman.json")).toEqual({
      skip: 100,
    });
  });

  it("defaults to 0 for negative skip", () => {
    expect(parseCatalogExtras("skip=-1.json")).toEqual({ skip: 0 });
  });

  it("defaults to 0 for non-numeric skip", () => {
    expect(parseCatalogExtras("skip=abc.json")).toEqual({ skip: 0 });
  });

  it("defaults to 0 when skip key is present without a value", () => {
    expect(parseCatalogExtras("skip=.json")).toEqual({ skip: 0 });
  });

  it("ignores malformed pairs without =", () => {
    expect(parseCatalogExtras("noequals.json")).toEqual({ skip: 0 });
    expect(parseCatalogExtras("noequals&skip=100.json")).toEqual({ skip: 100 });
  });

  it("decodes URL-encoded values", () => {
    expect(
      parseCatalogExtras("skip=100&search=game%20of%20thrones.json"),
    ).toEqual({
      skip: 100,
    });
  });
});
