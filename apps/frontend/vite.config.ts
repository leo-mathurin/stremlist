import { aiPages } from "./scripts/ai-pages";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { defineConfig, lazyPlugins, loadEnv, type Plugin } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { withRelatedProject } from "@vercel/related-projects";
import { ACCOUNT_KEY_SOURCE } from "@stremlist/shared/constants";

const APP_SOURCE = path.resolve(__dirname, "src") + path.sep;

/**
 * Fails the build when no emitted app module imports the compiler runtime,
 * so a broken `react({ compiler })` setup cannot ship unnoticed.
 */
function reactCompilerGuard(): Plugin {
  return {
    name: "stremlist-react-compiler-guard",
    apply: "build",
    applyToEnvironment: ({ config }) => config.consumer === "client",
    async generateBundle(_options, bundle) {
      const runtime = await this.resolve(
        "react/compiler-runtime",
        path.join(APP_SOURCE, "main.tsx"),
      );
      const compiled = Object.values(bundle).some(
        (output) =>
          output.type === "chunk" &&
          Object.keys(output.modules).some(
            (id) =>
              id.startsWith(APP_SOURCE) &&
              runtime !== null &&
              this.getModuleInfo(id)?.importedIds.includes(runtime.id),
          ),
      );
      if (!compiled) {
        this.error(
          "React Compiler is inactive: no app module imports react/compiler-runtime. Check react({ compiler }) in apps/frontend/vite.config.ts.",
        );
      }
    },
  };
}

const CONFIGURE_PATH = new RegExp(
  `^/(?:${ACCOUNT_KEY_SOURCE})/configure(?:\\?|$)`,
);

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

  const publicBackendUrl = useDevProxy
    ? "/api"
    : withRelatedProject({
        projectName: "stremlist-backend",
        defaultHost: env.VITE_BACKEND_URL ?? "http://localhost:7001",
      });

  return {
    plugins: lazyPlugins(() => [
      reactCompilerGuard(),
      react({ compiler: { logDiagnostics: true } }),
      tailwindcss(),
      aiPages(backendTarget ?? publicBackendUrl),
    ]),
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
                    CONFIGURE_PATH.test(request.url ?? "") &&
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
      dedupe: ["react", "react-dom"],
      alias: { "@": path.resolve(__dirname, "./src") },
    },
    define: {
      "import.meta.env.VITE_BACKEND_URL": JSON.stringify(publicBackendUrl),
    },
  };
});
