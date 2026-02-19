import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { withRelatedProject } from "@vercel/related-projects";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  define: {
    "import.meta.env.VITE_BACKEND_URL": JSON.stringify(
      withRelatedProject({
        projectName: "stremlist-backend",
        defaultHost: process.env.VITE_BACKEND_URL ?? "http://localhost:7001",
      }),
    ),
  },
});
