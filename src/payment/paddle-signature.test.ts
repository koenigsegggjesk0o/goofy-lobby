import { describe, expect, it } from 'vitest';
import {
  PADDLE_SIGNATURE_TOLERANCE_MS,
  computePaddleHmac,
  parsePaddleSignature,
  verifyPaddleSignature,
} from './paddle-signature';
import { makePaddleSignatureHeader, signPaddlePayload } from './test-utils';

// Secret DUMMY test — jelas-jelas bukan kredensial nyata (prefix
// 'test-secret-' sesuai konvensi modul).
const SECRET_PRIMARY = 'test-secret-primary';
const SECRET_SECONDARY = 'test-secret-secondary';
const SECRET_WRONG = 'test-secret-wrong';

const TS = 1_671_552_777; // contoh ts dokumentasi Paddle (unix detik)
const NOW_AT_TS = () => TS * 1000; // now dalam milidetik, tepat di ts
const BODY =
  '{"event_type":"transaction.completed","occurred_at":"2022-12-20T17:19:37Z","data":{}}';

// Hex 64 char deterministik untuk test format parser (nilai TIDAK perlu
// jadi HMAC sah — parser hanya memvalidasi bentuk).
const HEX_A = 'eb4d0dc8853be92b7f063b9f3ba5233eb920a09459b6e6b2c26705b4364db151';
const HEX_B = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('parsePaddleSignature', () => {
  it('header valid: ts + satu h1', () => {
    const result = parsePaddleSignature(`ts=${TS};h1=${HEX_A}`);
    expect(result).toEqual({ ok: true, value: { ts: TS, signatures: [HEX_A] } });
  });

  it('spasi di sekitar pemisah ; ditoleransi (bagian di-trim)', () => {
    const result = parsePaddleSignature(`  ts=${TS}  ;  h1=${HEX_A}  `);
    expect(result).toEqual({ ok: true, value: { ts: TS, signatures: [HEX_A] } });
  });

  it('multi-h1 (rotasi secret): SEMUA nilai h1 dikumpulkan, urutan terjaga', () => {
    const result = parsePaddleSignature(`ts=${TS};h1=${HEX_A};h1=${HEX_B}`);
    expect(result).toEqual({ ok: true, value: { ts: TS, signatures: [HEX_A, HEX_B] } });
  });

  it('h1 uppercase dinormalisasi lowercase', () => {
    const result = parsePaddleSignature(`ts=${TS};h1=${HEX_B.toUpperCase()}`);
    expect(result).toEqual({ ok: true, value: { ts: TS, signatures: [HEX_B] } });
  });

  it('kunci asing (mis. h2) diabaikan — forward-compatible', () => {
    const result = parsePaddleSignature(`ts=${TS};h2=${HEX_B};h1=${HEX_A}`);
    expect(result).toEqual({ ok: true, value: { ts: TS, signatures: [HEX_A] } });
  });

  it('tanpa ts → malformed-header', () => {
    expect(parsePaddleSignature(`h1=${HEX_A}`)).toEqual({ ok: false, reason: 'malformed-header' });
  });

  it('ts ganda → malformed-header (ambigu ditolak deterministik)', () => {
    expect(parsePaddleSignature(`ts=${TS};ts=${TS};h1=${HEX_A}`)).toEqual({
      ok: false,
      reason: 'malformed-header',
    });
  });

  it('tanpa h1 → malformed-header', () => {
    expect(parsePaddleSignature(`ts=${TS}`)).toEqual({ ok: false, reason: 'malformed-header' });
  });

  it('ts bukan angka → malformed-header', () => {
    expect(parsePaddleSignature(`ts=abc;h1=${HEX_A}`)).toEqual({
      ok: false,
      reason: 'malformed-header',
    });
    expect(parsePaddleSignature(`ts=17.7;h1=${HEX_A}`)).toEqual({
      ok: false,
      reason: 'malformed-header',
    });
  });

  it('ts dengan leading zero → malformed-header (kanonik wajib — rekonstruksi signed payload)', () => {
    expect(parsePaddleSignature(`ts=0${TS};h1=${HEX_A}`)).toEqual({
      ok: false,
      reason: 'malformed-header',
    });
  });

  it('h1 hex pendek / bukan hex → malformed-header', () => {
    expect(parsePaddleSignature(`ts=${TS};h1=abcd`)).toEqual({
      ok: false,
      reason: 'malformed-header',
    });
    expect(parsePaddleSignature(`ts=${TS};h1=${'g'.repeat(64)}`)).toEqual({
      ok: false,
      reason: 'malformed-header',
    });
  });

  it('bagian tanpa = / kunci kosong → malformed-header', () => {
    expect(parsePaddleSignature(`ts=${TS};h1=${HEX_A};garbage`)).toEqual({
      ok: false,
      reason: 'malformed-header',
    });
    expect(parsePaddleSignature(`=${HEX_A}`)).toEqual({ ok: false, reason: 'malformed-header' });
  });

  it('header kosong → malformed-header', () => {
    expect(parsePaddleSignature('')).toEqual({ ok: false, reason: 'malformed-header' });
  });
});

describe('computePaddleHmac', () => {
  it('menghasilkan HMAC-SHA256 hex lowercase — expected dihitung WebCrypto langsung di test', async () => {
    const secret = 'test-secret-compute';
    const signedPayload = '1671552777:{"a":1}';
    // Implementasi reference independen di sisi test (bukan angka karangan):
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(signedPayload));
    const expected = [...new Uint8Array(mac)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    const actual = await computePaddleHmac(secret, signedPayload);
    expect(actual).toBe(expected);
    expect(actual).toMatch(/^[0-9a-f]{64}$/);
  });

  it('known-answer: vektor terbitan standar RFC 4231 HMAC-SHA-256 Test Case 2', async () => {
    // Vektor PUBLIKED standar (bukan karangan): key "Jefe",
    // data "what do ya want for nothing?".
    expect(await computePaddleHmac('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  it('deterministik; payload beda satu karakter → mac beda', async () => {
    const a = await computePaddleHmac(SECRET_PRIMARY, '1:same');
    const b = await computePaddleHmac(SECRET_PRIMARY, '1:same');
    const c = await computePaddleHmac(SECRET_PRIMARY, '1:samf');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('verifyPaddleSignature', () => {
  it('happy path: signature dihitung reference test atas input tetap → lolos', async () => {
    const signature = await signPaddlePayload(SECRET_PRIMARY, TS, BODY);
    const result = await verifyPaddleSignature({
      header: makePaddleSignatureHeader(TS, [signature]),
      rawBody: BODY,
      secret: SECRET_PRIMARY,
      now: NOW_AT_TS,
    });
    expect(result).toEqual({ ok: true });
  });

  it('body dimodifikasi satu karakter → signature-mismatch', async () => {
    const signature = await signPaddlePayload(SECRET_PRIMARY, TS, BODY);
    const tampered = BODY.replace('transaction', 'transactioX');
    const result = await verifyPaddleSignature({
      header: makePaddleSignatureHeader(TS, [signature]),
      rawBody: tampered,
      secret: SECRET_PRIMARY,
      now: NOW_AT_TS,
    });
    expect(result).toEqual({ ok: false, reason: 'signature-mismatch' });
  });

  it('secret berbeda → signature-mismatch', async () => {
    const signature = await signPaddlePayload(SECRET_SECONDARY, TS, BODY);
    const result = await verifyPaddleSignature({
      header: makePaddleSignatureHeader(TS, [signature]),
      rawBody: BODY,
      secret: SECRET_WRONG,
      now: NOW_AT_TS,
    });
    expect(result).toEqual({ ok: false, reason: 'signature-mismatch' });
  });

  it('ts basi (masa lalu, di luar toleransi default) → stale-timestamp', async () => {
    const signature = await signPaddlePayload(SECRET_PRIMARY, TS, BODY);
    const result = await verifyPaddleSignature({
      header: makePaddleSignatureHeader(TS, [signature]),
      rawBody: BODY,
      secret: SECRET_PRIMARY,
      now: () => (TS + PADDLE_SIGNATURE_TOLERANCE_MS / 1000 + 1) * 1000,
    });
    expect(result).toEqual({ ok: false, reason: 'stale-timestamp' });
  });

  it('ts masa depan di luar toleransi → stale-timestamp (clock skew/replay ditolak absolut)', async () => {
    const signature = await signPaddlePayload(SECRET_PRIMARY, TS, BODY);
    const result = await verifyPaddleSignature({
      header: makePaddleSignatureHeader(TS, [signature]),
      rawBody: BODY,
      secret: SECRET_PRIMARY,
      now: () => (TS - PADDLE_SIGNATURE_TOLERANCE_MS / 1000 - 1) * 1000,
    });
    expect(result).toEqual({ ok: false, reason: 'stale-timestamp' });
  });

  it('toleranceMs custom memperluas jendela umur', async () => {
    const signature = await signPaddlePayload(SECRET_PRIMARY, TS, BODY);
    const input = {
      header: makePaddleSignatureHeader(TS, [signature]),
      rawBody: BODY,
      secret: SECRET_PRIMARY,
      now: () => TS * 1000 + 10_000, // 10 detik setelah ts
    } as const;
    // default 5000 ms → basi; custom 60_000 ms → lolos
    expect(await verifyPaddleSignature({ ...input, toleranceMs: 60_000 })).toEqual({ ok: true });
    expect(await verifyPaddleSignature({ ...input, toleranceMs: 1_000 })).toEqual({
      ok: false,
      reason: 'stale-timestamp',
    });
  });

  it('multi-h1 rotasi secret: cocok salah satu h1 → lolos (kedua secret valid)', async () => {
    const oldSignature = await signPaddlePayload(SECRET_SECONDARY, TS, BODY);
    const newSignature = await signPaddlePayload(SECRET_PRIMARY, TS, BODY);
    const header = makePaddleSignatureHeader(TS, [oldSignature, newSignature]);
    expect(
      await verifyPaddleSignature({
        header,
        rawBody: BODY,
        secret: SECRET_PRIMARY,
        now: NOW_AT_TS,
      }),
    ).toEqual({ ok: true });
    expect(
      await verifyPaddleSignature({
        header,
        rawBody: BODY,
        secret: SECRET_SECONDARY,
        now: NOW_AT_TS,
      }),
    ).toEqual({ ok: true });
    expect(
      await verifyPaddleSignature({ header, rawBody: BODY, secret: SECRET_WRONG, now: NOW_AT_TS }),
    ).toEqual({ ok: false, reason: 'signature-mismatch' });
  });

  it('header rusak → malformed-header (deterministik, tanpa exception)', async () => {
    const result = await verifyPaddleSignature({
      header: 'bukan-header-paddle',
      rawBody: BODY,
      secret: SECRET_PRIMARY,
      now: NOW_AT_TS,
    });
    expect(result).toEqual({ ok: false, reason: 'malformed-header' });
  });

  it('secret kosong → signature-mismatch deterministik (guard DataError WebCrypto)', async () => {
    const signature = await signPaddlePayload(SECRET_PRIMARY, TS, BODY);
    const result = await verifyPaddleSignature({
      header: makePaddleSignatureHeader(TS, [signature]),
      rawBody: BODY,
      secret: '',
      now: NOW_AT_TS,
    });
    expect(result).toEqual({ ok: false, reason: 'signature-mismatch' });
  });
});
