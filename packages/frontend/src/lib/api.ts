import { hcWithType } from "@stremlist/backend/client"

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? window.location.origin

export const api = hcWithType(`${BACKEND_URL}/api`)
