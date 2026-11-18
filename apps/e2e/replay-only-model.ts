const NO_RECORDING =
  "this AI goal has no usable recording, and a replay never calls a model. " +
  "Record it with `e2e-chatgpt-session bun run test:toolkit:record`, then " +
  "commit the new file of apps/e2e/.e2e/cache (README.md, Cache rules)";

function refuse(): never {
  throw new Error(NO_RECORDING);
}

/** An AI SDK language model that refuses every call. */
export const replayOnlyModel = {
  specificationVersion: "v3",
  provider: "stremlist-replay",
  modelId: "replay-only",
  supportedUrls: {},
  doGenerate: async () => refuse(),
  doStream: async () => refuse(),
};
