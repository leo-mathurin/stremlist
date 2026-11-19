import { once } from "node:events";
import { createServer } from "node:http";
import type { Page } from "@playwright/test";

/**
 * Answer the requests of `page` that match `pattern` from a loopback server
 * that sends `body` as `contentType`, so that no request leaves the machine.
 * The server stops when the page closes.
 */
export async function routeToLoopback(
  page: Page,
  pattern: string,
  answer: { contentType: string; body: string },
) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": answer.contentType });
    response.end(answer.body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("The loopback page server has no port");
  }
  page.once("close", () => server.close());
  const url = `http://127.0.0.1:${address.port}/`;
  await page.route(pattern, async (route) => {
    await route.fulfill({ response: await page.request.get(url) });
  });
}
