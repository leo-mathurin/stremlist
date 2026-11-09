import assert from "node:assert/strict";
import { test } from "node:test";
import { extractAccountKey } from "../src/lib/list-sources.ts";

const ACCOUNT = "sl_E2eFixtureAccount00001";
const HANDLE = "p.Ab3dEf9hIjkLmn0pQrStuvWxyz";

test("Addon URLs of every v1 key form give their key", () => {
  for (const key of [
    ACCOUNT,
    "ur12345678",
    "ur12",
    HANDLE,
    "ls123456789",
    "ur12345678ls123456789",
  ]) {
    for (const url of [
      `https://api.stremlist.com/${key}/manifest.json`,
      `stremio://api.stremlist.com/${key}/manifest.json`,
      `api.stremlist.com/${key}/manifest.json`,
      `https://stremlist-backend.vercel.app/${key}/configure`,
      `https://stremlist.com/configure?account=${key}`,
      `https://stremlist.com/configure?userId=${key}`,
      `https://stremlist.com/?userId=${key}`,
      `https://web.stremio.com/#/addons?addon=${encodeURIComponent(`https://api.stremlist.com/${key}/manifest.json`)}`,
    ]) {
      assert.equal(extractAccountKey(url), key, url);
    }
  }
});

test("bare keys give their key", () => {
  for (const key of [ACCOUNT, "ur12345678", HANDLE, "ls123456789"]) {
    assert.equal(extractAccountKey(` ${key} `), key);
  }
});

test("IMDb pages and other links are not Addon URLs", () => {
  for (const input of [
    "https://www.imdb.com/user/ur12345678/watchlist",
    "https://www.imdb.com/user/ur12345678",
    "https://www.imdb.com/list/ls123456789",
    "https://www.imdb.com/list/ls123456789/",
    `https://www.imdb.com/user/${HANDLE}/`,
    "https://trakt.tv/users/someone/watchlist",
    "https://api.stremlist.com/YOUR_IMDB_ID/manifest.json",
    "https://api.stremlist.com/ur12345678'--/manifest.json",
    "banana",
    "",
  ]) {
    assert.equal(extractAccountKey(input), null, input);
  }
});
