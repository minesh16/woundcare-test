import { createClient, SupabaseClient } from '@supabase/supabase-js';

/**
 * The server's single Supabase client (service role — never leaves the server).
 * Null when unconfigured; every caller degrades rather than failing a request.
 */
let client: SupabaseClient | null = null;

export function isStoreConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function db(): SupabaseClient | null {
  if (!isStoreConfigured()) return null;
  if (!client) {
    client = createClient(process.env.SUPABASE_URL as string, process.env.SUPABASE_SERVICE_ROLE_KEY as string, {
      auth: { persistSession: false },
    });
  }
  return client;
}
