import { joinProviderLabels } from "@stremlist/shared/providers";
import type { ProviderId } from "@stremlist/shared/providers";
import type { AddonAccess } from "@stremlist/shared/stremio.types";
import { listPayload } from "./list-form";
import type { ListFormRow } from "./list-form";
import { ACTION_PROVIDERS } from "./provider-groups";

/** "new" until the first save creates the Account. */
export type AccountAccess = "new" | AddonAccess;

/** What the configure page lets the user do for an access mode. */
export interface AccountEditPolicy {
  /**
   * Why the Lists and settings cannot change here, if they cannot: a Legacy
   * alias install that already got a private copy. The backend refuses its
   * changes (409), so the page only offers to make a new private URL.
   */
  editLock?: string;
  /** Why Actions cannot be turned on here, if they cannot. */
  actionsLock?: string;
  /**
   * Connecting a Provider needs a private Addon URL: a Legacy alias install
   * upgrades first.
   */
  upgradeToConnect: boolean;
  /**
   * What the Providers panel says about connecting: a new setup is saved
   * first, a Legacy alias install upgrades first.
   */
  connectHint: "save-first" | "upgrade" | null;
}

export function accountEditPolicy(
  access: AccountAccess,
  movedAt: string | null,
): AccountEditPolicy {
  const moved = access === "legacy" && !!movedAt;
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
    upgradeToConnect: access === "legacy",
    connectHint:
      access === "new"
        ? "save-first"
        : access === "legacy" && !moved
          ? "upgrade"
          : null,
  };
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
): ActionProviders {
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
  actionsEnabled: boolean;
  actions: ActionProviders;
  newTitlesEnabled: boolean;
}

/**
 * The body of a save. Only a private Account sends Actions: the others
 * cannot have them.
 */
export function configBody(form: AccountForm, access: AccountAccess) {
  return {
    rpdbApiKey: form.rpdbApiKey,
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
    newTitles: { enabled: form.newTitlesEnabled },
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
): boolean {
  return (
    JSON.stringify(configBody(latest, access)) !==
    JSON.stringify(configBody(submitted, access))
  );
}
