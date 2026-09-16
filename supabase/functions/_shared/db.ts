/**
 * db.ts -- the one connection to Supabase, using the service_role key.
 *
 * service_role bypasses Row Level Security. That is correct here (the edge
 * function IS the trusted server), and it is exactly why this key must never
 * be sent to Telegram, logged, or echoed into a model prompt.
 */

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { config } from "./config.ts";

let client: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (!client) {
    client = createClient(config.supabaseUrl, config.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

/**
 * Calls a Postgres function and returns its result, with the error surfaced as
 * a thrown Error rather than a silent null -- a briefing that quietly sends an
 * empty message is worse than one that fails loudly.
 */
export async function rpc<T = unknown>(
  fn: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const { data, error } = await db().rpc(fn, args);
  if (error) throw new Error(`rpc ${fn} failed: ${error.message}`);
  return data as T;
}
