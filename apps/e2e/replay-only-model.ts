// The model of the toolkit in CI and in `test:toolkit:replay` (both set CI).
// A replay makes no model call: each AI goal replays its committed
// recording. A goal without a usable recording (a new or edited goal or
// params, a renamed test, a `gap` or `truncated` recording) gets here and
// fails with what to do, before any request leaves the machine. Without this
// model the failure said "no ChatGPT login is stored", and with stored
// credentials the same run would ask the model again.

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
