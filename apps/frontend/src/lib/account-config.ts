import type { ProviderId } from "@stremlist/shared/providers";
import type { AddonAccess } from "@stremlist/shared/stremio.types";
import { listPayload } from "./list-form";
import type { ListFormRow } from "./list-form";

/** "new" until the first save creates the Account. */
export type AccountAccess = "new" | AddonAccess;

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
