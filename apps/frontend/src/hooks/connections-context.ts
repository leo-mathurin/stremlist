import { createContext } from "react";
import type { ConnectionSummary } from "@stremlist/shared/stremio.types";

/**
 * The Account's Connections, for the parts of the configure page that read
 * through them, such as the Catalog preview. None outside the page.
 */
export const ConnectionsContext = createContext<ConnectionSummary[]>([]);
