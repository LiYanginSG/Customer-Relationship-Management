/**
 * db.ts -- server-only database access.
 *
 * The "server-only" import at the top is load-bearing. If any of this is ever
 * imported from a Client Component by mistake, the BUILD FAILS rather than
 * quietly shipping the service-role key to the browser. That key bypasses
 * every row-level security policy, so it leaking would expose the whole book.
 */

import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

/**
 * Privileged client. Only reachable from Server Components and Server Actions,
 * and only ever after requireUser() has passed.
 */
export function db(): SupabaseClient {
  if (!cached) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error(
        "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. " +
          "Set both in your Vercel project settings.",
      );
    }
    cached = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return cached;
}
