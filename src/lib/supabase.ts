import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readClientEnv } from './env';

let cached: SupabaseClient | null = null;

/**
 * Singleton SupabaseClient untuk aplikasi (browser).
 * Membaca VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY — melempar error jelas
 * bila belum diisi. Sesi auth dipersist (localStorage) supaya signin bertahan.
 *
 * flowType 'pkce' (remediasi audit 25-a): alur auth memakai Proof Key for
 * Code Exchange — token verifikasi tidak pernah berpindah lewat URL, syarat
 * wajib sebelum Fase 3 mengaktifkan email-link/OAuth/magic link (default
 * library 'implicit' berisiko token di fragment URL).
 */
export function getAppSupabase(): SupabaseClient {
  if (cached === null) {
    const env = readClientEnv();
    cached = createClient(env.supabaseUrl, env.supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: 'pkce',
      },
    });
  }
  return cached;
}
