import { hcWithType } from "@stremlist/backend/client";

export const api = hcWithType(`${import.meta.env.VITE_BACKEND_URL}/api`);
