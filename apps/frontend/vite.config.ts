import path from "path";
import { execFileSync } from "node:child_process";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { withRelatedProject } from "@vercel/related-projects";

// https://vite.dev/config/
export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, __dirname, ["VITE_", "DEV_"]);
  const useDevProxy =
    command === "serve" &&
    (Boolean(process.env.PORTLESS_URL) || !env.VITE_BACKEND_URL);
  const backendTarget = useDevProxy
    ? env.DEV_BACKEND_URL ||
      (process.env.PORTLESS_URL
        ? execFileSync("portless", ["get", "api.stremlist"], {
            cwd: __dirname,
            encoding: "utf8",
          }).trim()
        : "http://localhost:7001")
    : undefined;

  return {
    plugins: [react(), tailwindcss()],
    server: {
      host: true,
      allowedHosts: ["dev-tower", ".ts.net"],
      proxy: backendTarget
        ? {
            "/api": {
              target: backendTarget,
              changeOrigin: true,
              rewrite: (url) => url.replace(/^\/api(?=\/|$)/, ""),
              configure: (proxy) => {
                proxy.on("proxyRes", (response, request) => {
                  // Stremio follows the addon URL to configure; keep that
                  // redirect on the browser's local or tailnet frontend origin.
                  if (
                    /^\/ur\d+\/configure(?:\?|$)/.test(request.url ?? "") &&
                    response.headers.location
                  ) {
                    const redirect = new URL(response.headers.location);
                    response.headers.location = `/configure${redirect.search}`;
                  }
                });
              },
            },
          }
        : undefined,
    },
    resolve: {
      alias: { "@": path.resolve(__dirname, "./src") },
    },
    define: {
      "import.meta.env.VITE_BACKEND_URL": JSON.stringify(
        useDevProxy
          ? "/api"
          : withRelatedProject({
              projectName: "stremlist-backend",
              defaultHost: env.VITE_BACKEND_URL ?? "http://localhost:7001",
            }),
      ),
    },
  };
});
