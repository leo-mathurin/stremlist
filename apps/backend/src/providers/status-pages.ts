import type { ProviderId } from "@stremlist/shared/providers";
import { z } from "zod";
import { providerFetchJson } from "./http";

/**
 * What a Provider's own status page says about the part Stremlist reads:
 * "down", "up", or null when the page cannot be read or does not say.
 */
export type StatusPageState = "down" | "up";

interface StatusPage {
  url: string;
  /** The state of the components Stremlist reads, or null. */
  read: (data: unknown) => StatusPageState | null;
}

/** "down" when any listed component is down, "up" when all are up. */
function stateOf(states: (boolean | null)[]): StatusPageState | null {
  if (states.length === 0) return null;
  if (states.some((down) => down === true)) return "down";
  return states.every((down) => down === false) ? "up" : null;
}

// UptimeRobot public status pages (Trakt, Simkl). Not a documented API: the
// page itself loads it. "danger" is a monitor that is down.
const uptimeRobotSchema = z.object({
  psp: z.object({
    monitors: z.array(
      z.object({
        name: z.string(),
        statusClass: z.string(),
        groupName: z.string().nullish(),
      }),
    ),
  }),
});

function uptimeRobot(
  pageId: string,
  host: string,
  isApi: (monitor: { name: string; groupName?: string | null }) => boolean,
): StatusPage {
  return {
    url: `https://${host}/api/getMonitorList/${pageId}`,
    read: (data) => {
      const parsed = uptimeRobotSchema.safeParse(data);
      if (!parsed.success) return null;
      return stateOf(
        parsed.data.psp.monitors
          .filter(isApi)
          .map((monitor) =>
            monitor.statusClass === "danger"
              ? true
              : monitor.statusClass === "success"
                ? false
                : null,
          ),
      );
    },
  };
}

// Better Stack status page (MDBList): "downtime" is a resource that is down.
const betterStackSchema = z.object({
  included: z.array(
    z.object({
      type: z.string(),
      attributes: z
        .object({
          public_name: z.string().nullish(),
          status: z.string().nullish(),
        })
        .loose(),
    }),
  ),
});

// Instatus status page (SensCritique).
const instatusSchema = z.object({
  components: z.array(z.object({ name: z.string(), status: z.string() })),
});

/**
 * The official status pages that say whether the part Stremlist reads is
 * down. Letterboxd, IMDb and JustWatch publish none.
 */
const STATUS_PAGES: Partial<Record<ProviderId, StatusPage>> = {
  trakt: uptimeRobot(
    "wVLWNFLGN9",
    "status.trakt.tv",
    (monitor) => monitor.groupName === "API",
  ),
  simkl: uptimeRobot(
    "Nx8xTN71j",
    "status.simkl.com",
    (monitor) => monitor.name === "API.simkl.com",
  ),
  mdblist: {
    url: "https://status.mdblist.com/index.json",
    read: (data) => {
      const parsed = betterStackSchema.safeParse(data);
      if (!parsed.success) return null;
      return stateOf(
        parsed.data.included
          .filter(
            (item) =>
              item.type === "status_page_resource" &&
              item.attributes.public_name === "api.mdblist.com",
          )
          .map((item) =>
            item.attributes.status === "downtime"
              ? true
              : item.attributes.status === "operational" ||
                  item.attributes.status === "degraded"
                ? false
                : null,
          ),
      );
    },
  },
  senscritique: {
    url: "https://status.senscritique.com/v2/components.json",
    read: (data) => {
      const parsed = instatusSchema.safeParse(data);
      if (!parsed.success) return null;
      return stateOf(
        parsed.data.components
          .filter((component) => component.name === "senscritique.com")
          .map((component) =>
            component.status === "MAJOROUTAGE" ||
            component.status === "PARTIALOUTAGE"
              ? true
              : component.status === "OPERATIONAL" ||
                  component.status === "DEGRADEDPERFORMANCE"
                ? false
                : null,
          ),
      );
    },
  },
};

/** The Providers with an official status page. */
export const STATUS_PAGE_PROVIDERS = Object.keys(STATUS_PAGES).filter(
  (id): id is ProviderId => id in STATUS_PAGES,
);

/**
 * What the Provider's official status page says, or null when it has none,
 * the page does not answer, or its format changed. Never throws: a status
 * page is an extra signal, never a reason to fail the monitor.
 */
export async function readStatusPage(
  provider: ProviderId,
): Promise<StatusPageState | null> {
  const page = STATUS_PAGES[provider];
  if (!page) return null;
  try {
    const { data } = await providerFetchJson(page.url, {
      timeoutMs: 10_000,
      retryOn429: false,
    });
    return page.read(data);
  } catch (error) {
    console.error(
      `Could not read the ${provider} status page:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
