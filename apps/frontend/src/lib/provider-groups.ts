import { PROVIDER_IDS, PROVIDERS } from "@stremlist/shared/providers";

/** Providers that offer Actions once connected. */
export const ACTION_PROVIDERS = PROVIDER_IDS.filter(
  (id) => PROVIDERS[id].actions.length > 0,
);

/** Providers that an Account can connect. */
export const CONNECTABLE_PROVIDERS = PROVIDER_IDS.filter(
  (id) => PROVIDERS[id].connection !== "none",
);
