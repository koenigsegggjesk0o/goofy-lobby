import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readClientEnv } from './env';

let cached: SupabaseClient | null = null;

/**
 * Singleton SupabaseClient untuk aplikasi (browser).
 * Membaca VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY — melempar error jelas
 * bila belum diisi. Sesi auth dipersist (localStorage) supaya signin bertahan.
 */
export function getAppSupabase(): SupabaseClient {
  if (cached === null) {
    const env = readClientEnv();
    cached = createClient(env.supabaseUrl, env.supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
  }
  return cached;
}
