import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { SupabaseStorageLike } from './types';

/**
 * Bukti kompatibilitas kontrak struktural modul soundboard terhadap
 * SupabaseClient ASLI (konstruksi klien tidak melakukan permintaan
 * jaringan apa pun). Tipe storage di types.ts didefinisikan ulang secara
 * lokal (menyalin pola src/profile/types.ts) — dibuktikan level-TYPE di
 * sini bahwa klien asli assignable tanpa cast, dan level-RUNTIME bahwa
 * rantai bucket yang dipakai CustomSoundService tersedia.
 */
describe('kompatibilitas struktural klien asli', () => {
  it('SupabaseClient asli assignable ke SupabaseStorageLike tanpa cast', () => {
    const client = createClient('https://example.supabase.co', 'anon-key');
    const asStorage: SupabaseStorageLike = client;
    expect(typeof asStorage.storage.from).toBe('function');
  });

  it('rantai bucket yang dipakai CustomSoundService tersedia di klien asli', () => {
    const client = createClient('https://example.supabase.co', 'anon-key');
    const bucket = client.storage.from('soundboard-sounds');
    expect(typeof bucket.upload).toBe('function');
    expect(typeof bucket.createSignedUrl).toBe('function');
    expect(typeof bucket.remove).toBe('function');
    expect(typeof bucket.list).toBe('function');
  });
});
