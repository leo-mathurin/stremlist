import type { MetadataLanguage } from "@stremlist/shared/metadata-language";
import type { PosterSource } from "@stremlist/shared/poster";
import { joinProviderLabels } from "@stremlist/shared/providers";
import type { ProviderId } from "@stremlist/shared/providers";
import type { AddonAccess } from "@stremlist/shared/stremio.types";
import { listPayload } from "./list-form";
import type { ListFormRow } from "./list-form";
import { newTitlesPayload } from "./new-titles";
import type { NewTitlesForm } from "./new-titles";
import { ACTION_PROVIDERS } from "./provider-groups";

/** "new" until the first save creates the Account. */
export type AccountAccess = "new" | AddonAccess;

interface AccountEditPolicy {
  editLock?: string;
  actionsLock?: string;
  watchLock?: string;
  upgradeToConnect: boolean;
  connectHint: "save-first" | "upgrade" | null;
}

export function accountEditPolicy(
  access: AccountAccess,
  upgradedTo: string | null,
) {
  const moved = access === "legacy" && !!upgradedTo;
  const editLock = moved
    ? "This install has a private URL now. Make changes from the configure page of your new install."
    : undefined;
  return {
    editLock,
    actionsLock:
      editLock ??
      (access === "legacy"
        ? "Actions need a private Addon URL. Upgrade this install first."
        : access === "new"
          ? `Save your setup and connect ${joinProviderLabels(ACTION_PROVIDERS, "or")} to use Actions.`
          : undefined),
    watchLock:
      editLock ??
      (access === "legacy"
        ? "Automatic watched marks need a private Addon URL. Upgrade this install first."
        : access === "new"
          ? "Save your setup first. Then link Stremio and connect an account."
          : undefined),
    upgradeToConnect: access === "legacy",
    connectHint:
      access === "new"
        ? "save-first"
        : access === "legacy" && !moved
          ? "upgrade"
          : null,
  } satisfies AccountEditPolicy;
}

/**
 * The Providers that can show Actions in Stremio, in the order the user
 * chose, and the ones turned on.
 */
export interface ActionProviders {
  order: ProviderId[];
  selected: ProviderId[];
}

/**
 * Fit the Actions choice to the Providers that can have Actions now
 * (`capable`): Providers of `order` keep their place, new ones come last,
 * and only capable ones stay selected.
 */
export function reconcileActionProviders(
  order: ProviderId[],
  selected: ProviderId[],
  capable: ProviderId[],
) {
  return {
    order: [
      ...order.filter((id) => capable.includes(id)),
      ...capable.filter((id) => !order.includes(id)),
    ],
    selected: selected.filter((id) => capable.includes(id)),
  };
}

/** What the configure page edits and saves for an Account. */
export interface AccountForm {
  lists: ListFormRow[];
  rpdbApiKey: string;
  posterSource: PosterSource;
  /** The language of Titles and descriptions in Stremio. */
  metadataLanguage: MetadataLanguage;
  /** Whether Catalog names start with "Stremlist". */
  catalogNamePrefix: boolean;
  actionsEnabled: boolean;
  actions: ActionProviders;
  /** The built-in "New titles" catalog, shown among the Lists when on. */
  newTitles: NewTitlesForm;
}

/**
 * The body of a save. Only a private Account sends Actions: the others
 * cannot have them.
 */
export function configBody(form: AccountForm, access: AccountAccess) {
  return {
    rpdbApiKey: form.rpdbApiKey,
    posterSource: form.posterSource,
    metadataLanguage: form.metadataLanguage,
    catalogNamePrefix: form.catalogNamePrefix,
    lists: listPayload(form.lists),
    actions:
      access === "private"
        ? {
            enabled: form.actionsEnabled,
            providers: form.actions.order.filter((id) =>
              form.actions.selected.includes(id),
            ),
          }
        : undefined,
    newTitles: newTitlesPayload(form.newTitles),
  };
}

/**
 * Whether `latest` has edits that a save of `submitted` did not send, such
 * as edits made while the save was in flight.
 */
export function hasUnsavedChanges(
  submitted: AccountForm,
  latest: AccountForm,
  access: AccountAccess,
) {
  return (
    JSON.stringify(configBody(latest, access)) !==
    JSON.stringify(configBody(submitted, access))
  );
}
