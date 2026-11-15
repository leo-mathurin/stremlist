// The real backend app behind Bun.serve, with outbound calls faked by
// mock-fetch. run.ts starts it as a child process; it is not for production.
import { resetStats, stats } from "./mock-fetch";

// Import the app only after the fetch mock is in place.
const { default: app } = await import("../src/index");

const port = Number(process.env.STRESS_PORT ?? 7099);
let requests = 0;
let peakRss = 0;

function sampleMemory(): number {
  const { rss } = process.memoryUsage();
  peakRss = Math.max(peakRss, rss);
  return rss;
}
setInterval(sampleMemory, 500).unref();

Bun.serve({
  port,
  hostname: "127.0.0.1",
  // Bun's maximum. A request that hangs shows up as slow, not as a reset.
  idleTimeout: 255,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/__stress/stats") {
      const rss = sampleMemory();
      return Response.json({
        ...stats,
        requests,
        rssMB: Math.round(rss / 1e6),
        peakRssMB: Math.round(peakRss / 1e6),
        heapMB: Math.round(process.memoryUsage().heapUsed / 1e6),
      });
    }
    if (pathname === "/__stress/reset") {
      resetStats();
      requests = 0;
      peakRss = sampleMemory();
      return Response.json({ ok: true });
    }
    requests++;
    return app.fetch(request);
  },
});

console.log(`Stress server on http://127.0.0.1:${String(port)}`);
