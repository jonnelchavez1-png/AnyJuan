import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';

let client = null;
/** One shared Supabase client (created on first use, so a missing config can be reported nicely first). */
export function getClient() {
  if (!client) {
    client = createClient(config.supabaseUrl, config.supabaseKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
  }
  return client;
}
