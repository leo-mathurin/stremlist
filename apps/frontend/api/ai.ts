import { withRelatedProject } from "@vercel/related-projects";
import { handleAiRequest } from "../src/lib/md/http";

export default {
  fetch(request: Request): Promise<Response> {
    const backendUrl = withRelatedProject({
      projectName: "stremlist-backend",
      defaultHost: process.env.VITE_BACKEND_URL ?? "http://localhost:7001",
    });
    return handleAiRequest(request, backendUrl);
  },
};
