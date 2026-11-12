import type { Database } from "@stremlist/shared/database";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables",
  );
}

/** SPIKE: bytes and calls to Supabase, for the load test's egress figure. */
export const supabaseTraffic = { calls: 0, bytes: 0 };

export const supabase = createClient<Database>(
  supabaseUrl,
  supabaseServiceRoleKey,
  {
    global: {
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        supabaseTraffic.calls += 1;
        const body = await response.arrayBuffer();
        supabaseTraffic.bytes += body.byteLength;
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      },
    },
  },
);
