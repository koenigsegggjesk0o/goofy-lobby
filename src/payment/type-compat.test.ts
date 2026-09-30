import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { asPaddleWebhookDb, asPremiumClient } from './types';
import type { SupabasePremiumLike, PaddleWebhookDbLike } from './types';

/**
 * Bukti kompatibilitas kontrak struktural modul payment terhadap
 * SupabaseClient ASLI (konstruksi klien tidak melakukan permintaan
 * jaringan apa pun).
 *
 * PostgREST: generics postgrest-js (GetResult atas schema `any`) memicu
 * TS2589 pada perbandingan struktural langsung, jadi dibuktikan RUNTIME —
 * menelusuri rantai persis yang dipakai PremiumStatusService dan router
 * webhook (paddle-webhook.ts) pada klien asli. Cast tunggal ada di
 * asPremiumClient()/asPaddleWebhookDb() (terdokumentasi di types.ts).
 */
describe('kompatibilitas struktural klien asli', () => {
  it('rantai PostgREST yang dipakai PremiumStatusService tersedia di klien asli', () => {
    const client = createClient('https://example.supabase.co', 'anon-key');
    const table = client.from('profiles');

    expect(typeof table.select).toBe('function');

    // Rantai baca: from().select('id,is_premium').eq().maybeSingle() → await-able.
    const selectChain = table.select('id,is_premium');
    expect(typeof selectChain.eq).toBe('function');
    const maybeSingle = selectChain.eq('id', '00000000-0000-0000-0000-000000000000').maybeSingle();
    expect(typeof (maybeSingle as unknown as { then?: unknown }).then).toBe('function');
  });

  it('asPremiumClient menghasilkan objek dengan bentuk SupabasePremiumLike', () => {
    const client = createClient('https://example.supabase.co', 'anon-key');
    const adapted: SupabasePremiumLike = asPremiumClient(client);
    expect(typeof adapted.from).toBe('function');
    const table = adapted.from('profiles');
    expect(typeof table.select).toBe('function');
  });

  it('rantai ledger 0021 yang dipakai router webhook tersedia di klien asli', () => {
    const client = createClient('https://example.supabase.co', 'anon-key');
    const adapted: PaddleWebhookDbLike = asPaddleWebhookDb(client);

    // Klaim idempotency: from('paddle_events').upsert(..., {onConflict,
    // ignoreDuplicates}).select('event_id') → await-able.
    const events = adapted.from('paddle_events');
    expect(typeof events.upsert).toBe('function');
    const claim = events.upsert(
      { event_id: 'evt_x', event_type: 'transaction.completed' },
      { onConflict: 'event_id', ignoreDuplicates: true },
    );
    expect(typeof claim.select).toBe('function');
    expect(typeof (claim.select('event_id') as unknown as { then?: unknown }).then).toBe(
      'function',
    );

    // Cari transaksi: from('paddle_transactions').select().eq().limit(1).
    const transactions = adapted.from('paddle_transactions');
    expect(typeof transactions.select).toBe('function');
    const found = transactions.select('user_id').eq('transaction_id', 'txn_x');
    expect(typeof found.limit).toBe('function');
    expect(typeof (found.limit(1) as unknown as { then?: unknown }).then).toBe('function');

    // Tandai refund: from('paddle_transactions').update().eq() → await-able.
    expect(typeof transactions.update).toBe('function');
    const marked = transactions
      .update({ refunded_at: '2026-10-01T00:00:00Z' })
      .eq('transaction_id', 'txn_x');
    expect(typeof (marked as unknown as { then?: unknown }).then).toBe('function');
  });
});
