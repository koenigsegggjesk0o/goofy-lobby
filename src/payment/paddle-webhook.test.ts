import { describe, expect, it } from 'vitest';
import { handlePaddleWebhook } from './paddle-webhook';
import { makePaddleSignatureHeader, signPaddlePayload } from './test-utils';
import type { ApplyPremiumStatus } from './types';

// Secret DUMMY test — jelas-jelas bukan kredensial nyata.
const SECRET = 'test-secret-webhook';
const TS = 1_671_552_777;
const NOW_AT_TS = () => TS * 1000;
const USER = '7db26a0a-9ce5-4558-bd08-9612e9e9febe';

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

function eventBody(eventType: string, data: unknown): string {
  return JSON.stringify({
    event_id: 'evt_test_01',
    event_type: eventType,
    occurred_at: '2022-12-20T17:19:37Z',
    data,
  });
}

/** Menandatangani body persis seperti Paddle lalu memanggil router. */
async function call(
  rawBody: string,
  apply: ApplyPremiumStatus,
  overrides: { secret?: string; now?: () => number } = {},
) {
  const secret = overrides.secret ?? SECRET;
  const signature = await signPaddlePayload(secret, TS, rawBody);
  return handlePaddleWebhook({
    header: makePaddleSignatureHeader(TS, [signature]),
    rawBody,
    secret,
    applyPremiumStatus: apply,
    now: overrides.now ?? NOW_AT_TS,
  });
}

describe('handlePaddleWebhook', () => {
  it('transaction.completed → apply(userId, true) dipanggil dengan userId benar', async () => {
    const spy = makeApply();
    const outcome = await call(
      eventBody('transaction.completed', { custom_data: { user_id: USER } }),
      spy.apply,
    );
    expect(outcome).toEqual({
      ok: true,
      handled: true,
      eventType: 'transaction.completed',
      userId: USER,
    });
    expect(spy.calls).toEqual([{ userId: USER, isPremium: true }]);
  });

  it('transaction.completed tanpa custom_data → missing-user-id, apply tidak dipanggil', async () => {
    const spy = makeApply();
    const outcome = await call(
      eventBody('transaction.completed', { custom_data: null }),
      spy.apply,
    );
    expect(outcome).toMatchObject({ ok: false, reason: 'missing-user-id' });
    expect(spy.calls).toEqual([]);
  });

  it('custom_data tanpa user_id → missing-user-id', async () => {
    const spy = makeApply();
    const outcome = await call(
      eventBody('transaction.completed', { custom_data: { order_ref: 'x' } }),
      spy.apply,
    );
    expect(outcome).toMatchObject({ ok: false, reason: 'missing-user-id' });
    expect(spy.calls).toEqual([]);
  });

  it('custom_data.user_id bukan uuid → missing-user-id (id tak pernah diteruskan tanpa validasi)', async () => {
    const spy = makeApply();
    const outcome = await call(
      eventBody('transaction.completed', { custom_data: { user_id: 'admin' } }),
      spy.apply,
    );
    expect(outcome).toMatchObject({ ok: false, reason: 'missing-user-id' });
    expect(spy.calls).toEqual([]);
  });

  it('subscription.canceled → apply(userId, false)', async () => {
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
    });
    expect(spy.calls).toEqual([{ userId: USER, isPremium: false }]);
  });

  it('event tak dikenal → acknowledged (handled:false) tanpa apply — aman utk event baru Paddle', async () => {
    const spy = makeApply();
    const outcome = await call(
      eventBody('product.created', { custom_data: { user_id: USER } }),
      spy.apply,
    );
    expect(outcome).toEqual({ ok: true, handled: false, eventType: 'product.created' });
    expect(spy.calls).toEqual([]);
  });

  it('signature salah (body ditukar satu karakter) → reason signature-mismatch, apply tidak dipanggil', async () => {
    const spy = makeApply();
    const rawBody = eventBody('transaction.completed', { custom_data: { user_id: USER } });
    const signature = await signPaddlePayload(SECRET, TS, rawBody);
    const outcome = await handlePaddleWebhook({
      header: makePaddleSignatureHeader(TS, [signature]),
      rawBody: rawBody.replace('evt_test_01', 'evt_test_0X'),
      secret: SECRET,
      applyPremiumStatus: spy.apply,
      now: NOW_AT_TS,
    });
    expect(outcome).toEqual({ ok: false, reason: 'signature-mismatch' });
    expect(spy.calls).toEqual([]);
  });

  it('ts basi (now di-inject jauh) → stale-timestamp', async () => {
    const spy = makeApply();
    const outcome = await call(
      eventBody('transaction.completed', { custom_data: { user_id: USER } }),
      spy.apply,
      { now: () => (TS + 3600) * 1000 },
    );
    expect(outcome).toEqual({ ok: false, reason: 'stale-timestamp' });
    expect(spy.calls).toEqual([]);
  });

  it('body bukan JSON → invalid-json (dengan detail)', async () => {
    const spy = makeApply();
    const outcome = await call('bukan json {{{', spy.apply);
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid-json' });
    expect(outcome.ok === false && outcome.detail !== undefined).toBe(true);
    expect(spy.calls).toEqual([]);
  });

  it('envelope rusak (event_type kosong / occurred_at absen) → invalid-event', async () => {
    const spy = makeApply();
    const missingType = await call(
      JSON.stringify({ occurred_at: '2022-12-20T17:19:37Z', data: {} }),
      spy.apply,
    );
    expect(missingType).toMatchObject({ ok: false, reason: 'invalid-event' });

    const emptyType = await call(eventBody('', {}), spy.apply);
    expect(emptyType).toMatchObject({ ok: false, reason: 'invalid-event' });

    const missingOccurredAt = await call(
      JSON.stringify({ event_type: 'transaction.completed', data: {} }),
      spy.apply,
    );
    expect(missingOccurredAt).toMatchObject({ ok: false, reason: 'invalid-event' });

    // Kunci data absen sepenuhnya — Zod 4 memperlakukan properti z.unknown()
    // sebagai kunci wajib, jadi event tanpa data juga invalid-event.
    const missingData = await call(
      JSON.stringify({ event_type: 'transaction.completed', occurred_at: '2022-12-20T17:19:37Z' }),
      spy.apply,
    );
    expect(missingData).toMatchObject({ ok: false, reason: 'invalid-event' });
  });

  it('data event bukan objek → invalid-event', async () => {
    const spy = makeApply();
    const outcome = await call(eventBody('transaction.completed', 'bukan-objek'), spy.apply);
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid-event' });
    expect(spy.calls).toEqual([]);
  });

  it('apply melempar → apply-failed dengan detail pesan error', async () => {
    const failing: ApplyPremiumStatus = async () => {
      throw new Error('db down');
    };
    const outcome = await call(
      eventBody('transaction.completed', { custom_data: { user_id: USER } }),
      failing,
    );
    expect(outcome).toEqual({ ok: false, reason: 'apply-failed', detail: 'db down' });
  });

  it('header kosong → malformed-header', async () => {
    const spy = makeApply();
    const outcome = await handlePaddleWebhook({
      header: '',
      rawBody: eventBody('transaction.completed', { custom_data: { user_id: USER } }),
      secret: SECRET,
      applyPremiumStatus: spy.apply,
      now: NOW_AT_TS,
    });
    expect(outcome).toEqual({ ok: false, reason: 'malformed-header' });
    expect(spy.calls).toEqual([]);
  });
});
