import { describe, expect, it } from 'vitest';
import {
  ChatError,
  DEFAULT_CONVERSATION_LIMIT,
  DEFAULT_MESSAGE_RATE_LIMIT,
  IsoTimestampSchema,
  MAX_CONVERSATION_LIMIT,
  MAX_MESSAGE_BODY_CHARS,
  MessageBodySchema,
  MessageRowSchema,
  UuidSchema,
} from './types';

const UUID_A = '7db26a0a-9ce5-4558-bd08-9612e9e9febe';
const UUID_B = '69f3f9b3-0d6f-4c22-98a4-6ad9a15be001';

describe('konstanta (kontrak selaras DB/policy)', () => {
  it('angka konstanta terkunci', () => {
    expect(MAX_MESSAGE_BODY_CHARS).toBe(500);
    expect(DEFAULT_CONVERSATION_LIMIT).toBe(50);
    expect(MAX_CONVERSATION_LIMIT).toBe(200);
    expect(DEFAULT_MESSAGE_RATE_LIMIT).toEqual({ maxEvents: 10, windowMs: 30_000 });
  });
});

describe('MessageBodySchema', () => {
  it('menerima 1–500 karakter dan memangkas whitespace tepi', () => {
    expect(MessageBodySchema.safeParse('a').success).toBe(true);
    expect(MessageBodySchema.safeParse('x'.repeat(500)).success).toBe(true);
    // 500 karakter + spasi tepi → trim → 500 → lolos (semantik btrim DB).
    expect(MessageBodySchema.safeParse(`  ${'x'.repeat(500)}  `).data).toBe('x'.repeat(500));
    expect(MessageBodySchema.safeParse('  halo kamu  ').data).toBe('halo kamu');
  });

  it('menolak kosong, whitespace-only, lebih dari 500, dan non-string', () => {
    expect(MessageBodySchema.safeParse('').success).toBe(false);
    expect(MessageBodySchema.safeParse('   ').success).toBe(false);
    expect(MessageBodySchema.safeParse('\t\n ').success).toBe(false);
    expect(MessageBodySchema.safeParse('x'.repeat(501)).success).toBe(false);
    expect(MessageBodySchema.safeParse('x'.repeat(501) + ' ').success).toBe(false);
    expect(MessageBodySchema.safeParse(123).success).toBe(false);
    expect(MessageBodySchema.safeParse(null).success).toBe(false);
  });
});

describe('UuidSchema', () => {
  it('menerima bentuk 8-4-4-4-12 heksadesimal (huruf besar/kecil)', () => {
    expect(UuidSchema.safeParse(UUID_A).success).toBe(true);
    expect(UuidSchema.safeParse(UUID_A.toUpperCase()).success).toBe(true);
    expect(UuidSchema.safeParse('00000000-0000-4000-8000-000000000001').success).toBe(true);
  });

  it('menolak bentuk asing', () => {
    expect(UuidSchema.safeParse('').success).toBe(false);
    expect(UuidSchema.safeParse('bukan-uuid').success).toBe(false);
    expect(UuidSchema.safeParse('7db26a0a9ce54558bd089612e9e9febe').success).toBe(false);
    expect(UuidSchema.safeParse('7db26a0a-9ce5-4558-bd08-9612e9e9febeg').success).toBe(false);
    expect(UuidSchema.safeParse(`'${UUID_A}' or '1'='1`).success).toBe(false);
  });
});

describe('IsoTimestampSchema', () => {
  it('menerima Z, offset, dan fraksi detik', () => {
    expect(IsoTimestampSchema.safeParse('2026-09-28T10:00:00Z').success).toBe(true);
    expect(IsoTimestampSchema.safeParse('2026-09-28T10:00:00z').success).toBe(true);
    expect(IsoTimestampSchema.safeParse('2026-09-28T10:00:00+00:00').success).toBe(true);
    expect(IsoTimestampSchema.safeParse('2026-09-28T10:00:00+07:00').success).toBe(true);
    expect(IsoTimestampSchema.safeParse('2026-09-28T10:00:00.123456Z').success).toBe(true);
  });

  it('menolak bentuk non-ISO', () => {
    expect(IsoTimestampSchema.safeParse('2026-09-28').success).toBe(false);
    expect(IsoTimestampSchema.safeParse('2026-09-28 10:00:00Z').success).toBe(false);
    expect(IsoTimestampSchema.safeParse('10:00:00').success).toBe(false);
    expect(IsoTimestampSchema.safeParse('2026-9-28T10:00:00Z').success).toBe(false);
    expect(IsoTimestampSchema.safeParse('').success).toBe(false);
    expect(IsoTimestampSchema.safeParse('kemarin').success).toBe(false);
  });
});

describe('MessageRowSchema', () => {
  const validRow = {
    id: UUID_A,
    sender_id: UUID_A,
    recipient_id: UUID_B,
    body: 'halo',
    created_at: '2026-09-28T10:00:00+00:00',
  };

  it('menerima baris valid', () => {
    expect(MessageRowSchema.safeParse(validRow).success).toBe(true);
  });

  it('menolak sender == recipient (messages_no_self)', () => {
    expect(MessageRowSchema.safeParse({ ...validRow, recipient_id: UUID_A }).success).toBe(false);
  });

  it('menolak kolom hilang / id bukan uuid / body kepanjangan / created_at non-ISO', () => {
    expect(MessageRowSchema.safeParse({ ...validRow, id: 'bukan-uuid' }).success).toBe(false);
    expect(MessageRowSchema.safeParse({ ...validRow, body: 'x'.repeat(501) }).success).toBe(false);
    expect(MessageRowSchema.safeParse({ ...validRow, created_at: 'kemarin' }).success).toBe(false);
    expect(MessageRowSchema.safeParse({ ...validRow, body: undefined }).success).toBe(false);
  });
});

describe('ChatError', () => {
  it('membawa code, cause, dan retryAfterMs terdokumentasi', () => {
    const cause = { message: 'asal' };
    const error = new ChatError('rate-limited', 'coba lagi dalam 250 ms', {
      cause,
      retryAfterMs: 250,
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ChatError');
    expect(error.code).toBe('rate-limited');
    expect(error.message).toContain('250');
    expect(error.retryAfterMs).toBe(250);
    expect(error.cause).toBe(cause);
  });

  it('tanpa opsi: cause dan retryAfterMs tidak terisi', () => {
    const error = new ChatError('not-friends', 'bukan teman');
    expect(error.code).toBe('not-friends');
    expect(error.cause).toBeUndefined();
    expect(error.retryAfterMs).toBeUndefined();
  });
});
