import { describe, expect, it } from 'vitest';
import { handlePaddleWebhook } from './paddle-webhook';
import { FakePaddleDb, makePaddleSignatureHeader, signPaddlePayload } from './test-utils';
import type { ApplyPremiumStatus, PaddleTransactionRow } from './types';

// Secret DUMMY test — jelas-jelas bukan kredensial nyata.
const SECRET = 'test-secret-webhook';
const TS = 1_671_552_777;
const NOW_AT_TS = () => TS * 1000;
const USER = '7db26a0a-9ce5-4558-bd08-9612e9e9febe';
const ALLOWED_PRICE = 'pri_test_allowed';
const TXN_ID = 'txn_test_01';

interface ApplySpy {
  apply: ApplyPremiumStatus;
  calls: Array<{ userId: string; isPremium: boolean }>;
}

/** Spy applyPremiumStatus — merekam panggilan tanpa efek samping. */
function makeApply(): ApplySpy {
  const calls: ApplySpy['calls'] = [];
  return {
    calls,
    apply: async (userId, isPremium) => {
      calls.push({ userId, isPremium });
    },
  };
}

function eventBody(eventType: string, data: unknown, eventId = 'evt_test_01'): string {
  return JSON.stringify({
    event_id: eventId,
    event_type: eventType,
    occurred_at: '2022-12-20T17:19:37Z',
    data,
  });
}

/** Payload transaction.completed sah (price_id lolos allowlist default). */
function txnData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TXN_ID,
    items: [{ price: { id: ALLOWED_PRICE } }],
    amount_total: 300,
    currency: 'USD',
    custom_data: { user_id: USER },
    ...overrides,
  };
}

function adjustmentData(
  action: 'refund' | 'credit' | 'charge',
  status: 'approved' | 'pending' | 'rejected',
  transactionId = TXN_ID,
): Record<string, unknown> {
  return { action, status, transaction_id: transactionId };
}

/** Baris transaksi SEED utk jalur refund (bentuk DB 0021). */
function seedTransaction(overrides: Partial<PaddleTransactionRow> = {}): PaddleTransactionRow {
  return {
    transaction_id: TXN_ID,
    user_id: USER,
    price_id: ALLOWED_PRICE,
    amount_total: 300,
    currency: 'USD',
    status: 'completed',
    refunded_at: null,
    ...overrides,
  };
}

/** Menandatangani body persis seperti Paddle lalu memanggil router. */
async function call(
  rawBody: string,
  apply: ApplyPremiumStatus,
  overrides: {
    secret?: string;
    now?: () => number;
    db?: FakePaddleDb;
    allowedPriceIds?: readonly string[];
  } = {},
) {
  const secret = overrides.secret ?? SECRET;
  const signature = await signPaddlePayload(secret, TS, rawBody);
  return handlePaddleWebhook({
    header: makePaddleSignatureHeader(TS, [signature]),
    rawBody,
    secret,
    applyPremiumStatus: apply,
    db: overrides.db ?? new FakePaddleDb(),
    allowedPriceIds: overrides.allowedPriceIds ?? [ALLOWED_PRICE],
    now: overrides.now ?? NOW_AT_TS,
  });
}

describe('handlePaddleWebhook — verifikasi keaslian (dipertahankan)', () => {
  it('signature salah (body ditukar satu karakter) → reason signature-mismatch, apply tidak dipanggil', async () => {
    const spy = makeApply();
    const db = new FakePaddleDb();
    const rawBody = eventBody('transaction.completed', txnData());
    const signature = await signPaddlePayload(SECRET, TS, rawBody);
    const outcome = await handlePaddleWebhook({
      header: makePaddleSignatureHeader(TS, [signature]),
      rawBody: rawBody.replace('evt_test_01', 'evt_test_0X'),
      secret: SECRET,
      applyPremiumStatus: spy.apply,
      db,
      allowedPriceIds: [ALLOWED_PRICE],
      now: NOW_AT_TS,
    });
    expect(outcome).toEqual({ ok: false, reason: 'signature-mismatch' });
    expect(spy.calls).toEqual([]);
    // Ledger TIDAK tersentuh — klaim hanya terjadi setelah envelope valid.
    expect(db.claimCalls).toEqual([]);
  });

  it('ts basi (now di-inject jauh) → stale-timestamp', async () => {
    const spy = makeApply();
    const outcome = await call(eventBody('transaction.completed', txnData()), spy.apply, {
      now: () => (TS + 3600) * 1000,
    });
    expect(outcome).toEqual({ ok: false, reason: 'stale-timestamp' });
    expect(spy.calls).toEqual([]);
  });

  it('header kosong → malformed-header', async () => {
    const spy = makeApply();
    const outcome = await handlePaddleWebhook({
      header: '',
      rawBody: eventBody('transaction.completed', txnData()),
      secret: SECRET,
      applyPremiumStatus: spy.apply,
      db: new FakePaddleDb(),
      now: NOW_AT_TS,
    });
    expect(outcome).toEqual({ ok: false, reason: 'malformed-header' });
    expect(spy.calls).toEqual([]);
  });
});

describe('handlePaddleWebhook — idempotency (migrasi 0021, audit 25 B2)', () => {
  it('event pertama → grant; event yang SAMA dikirim ulang → duplicate, tanpa double-apply', async () => {
    const spy = makeApply();
    const db = new FakePaddleDb();
    const body = eventBody('transaction.completed', txnData());

    const first = await call(body, spy.apply, { db });
    expect(first).toEqual({
      ok: true,
      handled: true,
      eventType: 'transaction.completed',
      userId: USER,
      status: 'granted',
    });

    const replay = await call(body, spy.apply, { db });
    expect(replay).toEqual({
      ok: true,
      handled: false,
      eventType: 'transaction.completed',
      status: 'duplicate',
    });
    // Satu-satunya jaminan B2: apply & upsert transaksi TIDAK dobel.
    expect(spy.calls).toEqual([{ userId: USER, isPremium: true }]);
    expect(db.transactionUpsertCalls).toHaveLength(1);
    // Klaim kedua tetap dikirim (on conflict do nothing) — idempoten di db.
    expect(db.claimCalls).toHaveLength(2);
    expect(db.claimCalls[0]).toMatchObject({
      values: { event_id: 'evt_test_01', event_type: 'transaction.completed' },
      options: { onConflict: 'event_id', ignoreDuplicates: true },
    });
  });

  it('klaim ledger gagal (db down) → apply-failed dengan detail, tanpa apply', async () => {
    const spy = makeApply();
    const outcome = await call(eventBody('transaction.completed', txnData()), spy.apply, {
      db: new FakePaddleDb({ failClaimWith: { message: 'connection refused' } }),
    });
    expect(outcome).toEqual({
      ok: false,
      reason: 'apply-failed',
      detail: 'claim paddle_events gagal: connection refused',
    });
    expect(spy.calls).toEqual([]);
  });
});

describe('handlePaddleWebhook — verifikasi harga (allowlist, audit 25 MEDIUM)', () => {
  it('price di dalam allowlist → grant + baris completed (amount/currency tercatat)', async () => {
    const spy = makeApply();
    const db = new FakePaddleDb();
    const outcome = await call(eventBody('transaction.completed', txnData()), spy.apply, {
      db,
      allowedPriceIds: [ALLOWED_PRICE, 'pri_lain'],
    });
    expect(outcome).toMatchObject({ ok: true, status: 'granted', userId: USER });
    expect(spy.calls).toEqual([{ userId: USER, isPremium: true }]);
    expect(db.transactions.get(TXN_ID)).toEqual(seedTransaction());
    expect(db.transactionUpsertCalls[0]?.options).toEqual({ onConflict: 'transaction_id' });
  });

  it('allowlist KOSONG → tanpa grant, baris price_rejected, outcome tetap ok (200)', async () => {
    const spy = makeApply();
    const db = new FakePaddleDb();
    const outcome = await call(eventBody('transaction.completed', txnData()), spy.apply, {
      db,
      allowedPriceIds: [],
    });
    expect(outcome).toEqual({
      ok: true,
      handled: true,
      eventType: 'transaction.completed',
      userId: USER,
      status: 'price_rejected',
    });
    expect(spy.calls).toEqual([]);
    expect(db.transactions.get(TXN_ID)).toEqual(seedTransaction({ status: 'price_rejected' }));
  });

  it('allowlist tidak dikirim sama sekali → fail-closed seperti kosong', async () => {
    const spy = makeApply();
    const db = new FakePaddleDb();
    const rawBody = eventBody('transaction.completed', txnData());
    const signature = await signPaddlePayload(SECRET, TS, rawBody);
    const outcome = await handlePaddleWebhook({
      header: makePaddleSignatureHeader(TS, [signature]),
      rawBody,
      secret: SECRET,
      applyPremiumStatus: spy.apply,
      db,
      now: NOW_AT_TS,
    });
    expect(outcome).toMatchObject({ ok: true, status: 'price_rejected' });
    expect(spy.calls).toEqual([]);
  });

  it('price di LUAR allowlist → tanpa grant, baris price_rejected', async () => {
    const spy = makeApply();
    const db = new FakePaddleDb();
    const outcome = await call(
      eventBody('transaction.completed', txnData({ items: [{ price: { id: 'pri_musuh' } }] })),
      spy.apply,
      { db, allowedPriceIds: [ALLOWED_PRICE] },
    );
    expect(outcome).toMatchObject({ ok: true, status: 'price_rejected' });
    expect(spy.calls).toEqual([]);
    expect(db.transactions.get(TXN_ID)).toMatchObject({
      status: 'price_rejected',
      price_id: 'pri_musuh',
    });
  });

  it('amount_total/currency absen → baris tetap tercatat dengan null', async () => {
    const spy = makeApply();
    const db = new FakePaddleDb();
    const outcome = await call(
      eventBody('transaction.completed', txnData({ amount_total: undefined, currency: undefined })),
      spy.apply,
      { db },
    );
    expect(outcome).toMatchObject({ ok: true, status: 'granted' });
    expect(db.transactions.get(TXN_ID)).toEqual(
      seedTransaction({ amount_total: null, currency: null }),
    );
  });

  it('upsert transaksi gagal → apply-failed, premium TIDAK di-grant', async () => {
    const spy = makeApply();
    const outcome = await call(eventBody('transaction.completed', txnData()), spy.apply, {
      db: new FakePaddleDb({ failTransactionUpsertWith: { message: 'rls violation' } }),
    });
    expect(outcome).toEqual({
      ok: false,
      reason: 'apply-failed',
      detail: 'upsert paddle_transactions gagal: rls violation',
    });
    expect(spy.calls).toEqual([]);
  });
});

describe('handlePaddleWebhook — refund (adjustment, audit 25 MEDIUM)', () => {
  it('adjustment refund approved → premium dicabut + refunded_at terisi', async () => {
    const spy = makeApply();
    const db = new FakePaddleDb({ transactions: [seedTransaction()] });
    const outcome = await call(
      eventBody('adjustment.created', adjustmentData('refund', 'approved')),
      spy.apply,
      { db },
    );
    expect(outcome).toEqual({
      ok: true,
      handled: true,
      eventType: 'adjustment.created',
      userId: USER,
      status: 'revoked',
    });
    expect(spy.calls).toEqual([{ userId: USER, isPremium: false }]);
    const row = db.transactions.get(TXN_ID);
    expect(row?.refunded_at).toEqual(expect.any(String));
    expect(db.transactionUpdateCalls[0]?.filters).toEqual({ transaction_id: TXN_ID });
  });

  it('adjustment credit approved (.updated) → dicabut juga', async () => {
    const spy = makeApply();
    const db = new FakePaddleDb({ transactions: [seedTransaction()] });
    const outcome = await call(
      eventBody('adjustment.updated', adjustmentData('credit', 'approved')),
      spy.apply,
      { db },
    );
    expect(outcome).toMatchObject({ ok: true, status: 'revoked' });
    expect(spy.calls).toEqual([{ userId: USER, isPremium: false }]);
  });

  it('refund pending → TIDAK dicabut, refunded_at tetap null, 200', async () => {
    const spy = makeApply();
    const db = new FakePaddleDb({ transactions: [seedTransaction()] });
    const outcome = await call(
      eventBody('adjustment.created', adjustmentData('refund', 'pending')),
      spy.apply,
      { db },
    );
    expect(outcome).toEqual({ ok: true, handled: false, eventType: 'adjustment.created' });
    expect(spy.calls).toEqual([]);
    expect(db.transactions.get(TXN_ID)?.refunded_at).toBeNull();
  });

  it('refund rejected & action charge → tidak mengubah apa pun', async () => {
    const spy = makeApply();
    const db = new FakePaddleDb({ transactions: [seedTransaction()] });
    const rejected = await call(
      eventBody('adjustment.updated', adjustmentData('refund', 'rejected')),
      spy.apply,
      { db },
    );
    expect(rejected).toMatchObject({ ok: true, handled: false });
    const charge = await call(
      eventBody('adjustment.created', adjustmentData('charge', 'approved')),
      spy.apply,
      {
        db,
      },
    );
    expect(charge).toMatchObject({ ok: true, handled: false });
    expect(spy.calls).toEqual([]);
    expect(db.transactionUpdateCalls).toEqual([]);
  });

  it('adjustment utk transaksi tak dikenal → 200 tanpa crash, tanpa apply', async () => {
    const spy = makeApply();
    const db = new FakePaddleDb();
    const outcome = await call(
      eventBody('adjustment.created', adjustmentData('refund', 'approved', 'txn_tak_dikenal')),
      spy.apply,
      { db },
    );
    expect(outcome).toEqual({ ok: true, handled: false, eventType: 'adjustment.created' });
    expect(spy.calls).toEqual([]);
    expect(db.transactionUpdateCalls).toEqual([]);
  });

  it('cari transaksi gagal (db down) → apply-failed', async () => {
    const spy = makeApply();
    const outcome = await call(
      eventBody('adjustment.created', adjustmentData('refund', 'approved')),
      spy.apply,
      { db: new FakePaddleDb({ failTransactionFindWith: { message: 'connection refused' } }) },
    );
    expect(outcome).toEqual({
      ok: false,
      reason: 'apply-failed',
      detail: 'cari paddle_transactions gagal: connection refused',
    });
    expect(spy.calls).toEqual([]);
  });
});

describe('handlePaddleWebhook — pemetaan user & langganan', () => {
  it('subscription.canceled → apply(userId, false) + status revoked', async () => {
    const spy = makeApply();
    const outcome = await call(
      eventBody('subscription.canceled', { custom_data: { user_id: USER } }),
      spy.apply,
    );
    expect(outcome).toEqual({
      ok: true,
      handled: true,
      eventType: 'subscription.canceled',
      userId: USER,
      status: 'revoked',
    });
    expect(spy.calls).toEqual([{ userId: USER, isPremium: false }]);
  });

  it('transaction.completed tanpa custom_data → missing-user-id, apply tidak dipanggil', async () => {
    const spy = makeApply();
    const outcome = await call(
      eventBody('transaction.completed', txnData({ custom_data: null })),
      spy.apply,
    );
    expect(outcome).toEqual({ ok: false, reason: 'missing-user-id' });
    expect(outcome.ok === false && outcome.detail).toBeUndefined();
    expect(spy.calls).toEqual([]);
  });

  it('custom_data tanpa user_id → missing-user-id', async () => {
    const spy = makeApply();
    const outcome = await call(
      eventBody('transaction.completed', txnData({ custom_data: { order_ref: 'x' } })),
      spy.apply,
    );
    expect(outcome).toMatchObject({ ok: false, reason: 'missing-user-id' });
    expect(spy.calls).toEqual([]);
  });

  it('custom_data.user_id bukan uuid → missing-user-id (id tak pernah diteruskan tanpa validasi)', async () => {
    const spy = makeApply();
    const outcome = await call(
      eventBody('transaction.completed', txnData({ custom_data: { user_id: 'admin' } })),
      spy.apply,
    );
    expect(outcome).toMatchObject({ ok: false, reason: 'missing-user-id' });
    expect(spy.calls).toEqual([]);
  });

  it('apply melempar → apply-failed dengan detail pesan error', async () => {
    const failing: ApplyPremiumStatus = async () => {
      throw new Error('db down');
    };
    const outcome = await call(eventBody('transaction.completed', txnData()), failing);
    expect(outcome).toEqual({ ok: false, reason: 'apply-failed', detail: 'db down' });
  });

  it('event tak dikenal → acknowledged (handled:false) tanpa apply — aman utk event baru Paddle', async () => {
    const spy = makeApply();
    const db = new FakePaddleDb();
    const outcome = await call(
      eventBody('product.created', { custom_data: { user_id: USER } }),
      spy.apply,
      { db },
    );
    expect(outcome).toEqual({ ok: true, handled: false, eventType: 'product.created' });
    expect(spy.calls).toEqual([]);
    // Event tak dikenal tetap DIKLAIM (diproses sekali) — replay-nya nanti
    // di-acknowledge sebagai duplicate.
    expect(db.claimedEvents.has('evt_test_01')).toBe(true);
  });
});

describe('handlePaddleWebhook — bentuk payload (400 generik, audit 23-c LOW)', () => {
  it('body bukan JSON → invalid-json TANPA detail di outcome (detail hanya console.error)', async () => {
    const spy = makeApply();
    const outcome = await call('bukan json {{{', spy.apply);
    expect(outcome).toEqual({ ok: false, reason: 'invalid-json' });
    expect(outcome.ok === false && outcome.detail).toBeUndefined();
    expect(spy.calls).toEqual([]);
  });

  it('envelope rusak (event_type kosong / occurred_at absen / event_id absen) → invalid-event tanpa detail', async () => {
    const spy = makeApply();
    const missingType = await call(
      JSON.stringify({ event_id: 'evt_x', occurred_at: '2022-12-20T17:19:37Z', data: {} }),
      spy.apply,
    );
    expect(missingType).toEqual({ ok: false, reason: 'invalid-event' });

    const emptyType = await call(eventBody('', {}), spy.apply);
    expect(emptyType).toEqual({ ok: false, reason: 'invalid-event' });

    const missingOccurredAt = await call(
      JSON.stringify({ event_id: 'evt_x', event_type: 'transaction.completed', data: {} }),
      spy.apply,
    );
    expect(missingOccurredAt).toEqual({ ok: false, reason: 'invalid-event' });

    // event_id kini WAJIB (idempotency 0021) — absen = invalid-event.
    const missingEventId = await call(
      JSON.stringify({
        event_type: 'transaction.completed',
        occurred_at: '2022-12-20T17:19:37Z',
        data: {},
      }),
      spy.apply,
    );
    expect(missingEventId).toEqual({ ok: false, reason: 'invalid-event' });

    // Kunci data absen sepenuhnya — Zod 4 memperlakukan properti z.unknown()
    // sebagai kunci wajib, jadi event tanpa data juga invalid-event.
    const missingData = await call(
      JSON.stringify({
        event_id: 'evt_x',
        event_type: 'transaction.completed',
        occurred_at: '2022-12-20T17:19:37Z',
      }),
      spy.apply,
    );
    expect(missingData).toEqual({ ok: false, reason: 'invalid-event' });
  });

  it('data event bukan objek → invalid-event', async () => {
    const spy = makeApply();
    const outcome = await call(eventBody('transaction.completed', 'bukan-objek'), spy.apply);
    expect(outcome).toEqual({ ok: false, reason: 'invalid-event' });
    expect(spy.calls).toEqual([]);
  });

  it('payload transaction tanpa items / items kosong → invalid-event tanpa detail', async () => {
    const spy = makeApply();
    const noItems = await call(
      eventBody('transaction.completed', txnData({ items: undefined })),
      spy.apply,
    );
    expect(noItems).toEqual({ ok: false, reason: 'invalid-event' });
    expect(noItems.ok === false && noItems.detail).toBeUndefined();

    const emptyItems = await call(
      eventBody('transaction.completed', txnData({ items: [] })),
      spy.apply,
    );
    expect(emptyItems).toEqual({ ok: false, reason: 'invalid-event' });
    expect(spy.calls).toEqual([]);
  });

  it('payload adjustment dengan action asing → invalid-event tanpa detail', async () => {
    const spy = makeApply();
    const outcome = await call(
      eventBody('adjustment.created', {
        action: 'voodoo',
        status: 'approved',
        transaction_id: TXN_ID,
      }),
      spy.apply,
    );
    expect(outcome).toEqual({ ok: false, reason: 'invalid-event' });
    expect(outcome.ok === false && outcome.detail).toBeUndefined();
    expect(spy.calls).toEqual([]);
  });
});
