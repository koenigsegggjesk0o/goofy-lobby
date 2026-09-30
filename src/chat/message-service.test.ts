import { describe, expect, it } from 'vitest';
import { MessageService } from './message-service';
import { FakeChatClient } from './test-utils';
import type { FriendshipRow, SelectCallLog } from './test-utils';
import { ChatError } from './types';
import type { MessageRow } from './types';
import type { RateLimiterLike, RateLimitResult } from './rate-limiter';

const ALICE = '00000000-0000-4000-8000-000000000001';
const BOB = '00000000-0000-4000-8000-000000000002';
const CAROL = '00000000-0000-4000-8000-000000000003';

let rowSeq = 0;
function messageRow(
  sender: string,
  recipient: string,
  body: string,
  createdAt: string,
): MessageRow {
  rowSeq += 1;
  return {
    id: `40000000-0000-4000-8000-${String(rowSeq).padStart(12, '0')}`,
    sender_id: sender,
    recipient_id: recipient,
    body,
    created_at: createdAt,
  };
}

let friendSeq = 0;
function friendship(
  requester: string,
  addressee: string,
  status: FriendshipRow['status'] = 'accepted',
): FriendshipRow {
  friendSeq += 1;
  return {
    id: `50000000-0000-4000-8000-${String(friendSeq).padStart(12, '0')}`,
    requester_id: requester,
    addressee_id: addressee,
    status,
    created_at: '2026-09-28T09:00:00Z',
    updated_at: '2026-09-28T09:00:00Z',
  };
}

/** Rate limiter stub — selalu mengembalikan hasil yang dipasang di constructor. */
class StubRateLimiter implements RateLimiterLike {
  readonly keys: string[] = [];

  constructor(private readonly result: RateLimitResult) {}

  tryAcquire(key: string): RateLimitResult {
    this.keys.push(key);
    return this.result;
  }
}

const ALLOW: RateLimitResult = { allowed: true, remaining: 99, retryAfterMs: 0 };

function makeService(client: FakeChatClient, limiter?: RateLimiterLike): MessageService {
  return new MessageService({
    supabase: client,
    rateLimiter: limiter ?? new StubRateLimiter(ALLOW),
  });
}

/** Menangkap error rejection sebagai value untuk assertion bertingkat. */
async function captureError(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error('aksi seharusnya melempar');
}

describe('MessageService.sendMessage', () => {
  it('happy path: gate pertemanan → insert body hasil-trim → ChatMessage camelCase', async () => {
    const client = new FakeChatClient({ friendships: [friendship(ALICE, BOB)] });
    const service = makeService(client);

    const message = await service.sendMessage(ALICE, BOB, '  halo Bob  ');

    expect(message).toEqual({
      id: '00000000-0000-4000-8000-000000000001',
      senderId: ALICE,
      recipientId: BOB,
      body: 'halo Bob',
      createdAt: '2026-09-28T12:00:00Z',
    });
    expect(client.insertCalls).toEqual([
      { values: { sender_id: ALICE, recipient_id: BOB, body: 'halo Bob' } },
    ]);
    expect(client.messages).toHaveLength(1);
    const gate: SelectCallLog = {
      table: 'friendships',
      or: `and(requester_id.eq.${ALICE},addressee_id.eq.${BOB}),and(requester_id.eq.${BOB},addressee_id.eq.${ALICE})`,
      eq: { status: 'accepted' },
      lt: {},
      maybeSingle: true,
    };
    expect(client.selectCalls).toEqual([gate]);
  });

  it('friendship arah terbalik (penerima yang meminta) juga lolos gate', async () => {
    const client = new FakeChatClient({ friendships: [friendship(BOB, ALICE)] });
    const service = makeService(client);
    const message = await service.sendMessage(ALICE, BOB, 'halo');
    expect(message.senderId).toBe(ALICE);
    expect(client.insertCalls).toHaveLength(1);
  });

  it('body 500 karakter (± spasi tepi) diterima persis di batas constraint', async () => {
    const client = new FakeChatClient({ friendships: [friendship(ALICE, BOB)] });
    const service = makeService(client);
    const message = await service.sendMessage(ALICE, BOB, `  ${'x'.repeat(500)}  `);
    expect(message.body).toBe('x'.repeat(500));
  });

  it('body 501 / whitespace-only / non-string ditolak invalid-body SEBELUM kueri', async () => {
    const client = new FakeChatClient({ friendships: [friendship(ALICE, BOB)] });
    const limiter = new StubRateLimiter(ALLOW);
    const service = makeService(client, limiter);

    await expect(service.sendMessage(ALICE, BOB, 'x'.repeat(501))).rejects.toMatchObject({
      code: 'invalid-body',
    });
    await expect(service.sendMessage(ALICE, BOB, '   \n\t ')).rejects.toMatchObject({
      code: 'invalid-body',
    });
    await expect(service.sendMessage(ALICE, BOB, 123 as unknown as string)).rejects.toMatchObject({
      code: 'invalid-body',
    });

    expect(client.fromCalls).toEqual([]);
    expect(limiter.keys).toEqual([]); // validasi gagal tidak mengonsumsi slot
  });

  it('uuid tidak valid ditolak invalid-uuid SEBELUM interpolasi filter', async () => {
    const client = new FakeChatClient({ friendships: [friendship(ALICE, BOB)] });
    const service = makeService(client);
    await expect(service.sendMessage('bukan-uuid', BOB, 'halo')).rejects.toMatchObject({
      code: 'invalid-uuid',
    });
    await expect(service.sendMessage(ALICE, "x' or '1'='1", 'halo')).rejects.toMatchObject({
      code: 'invalid-uuid',
    });
    expect(client.fromCalls).toEqual([]);
  });

  it('kirim ke diri sendiri ditolak self tanpa menyentuh jaringan', async () => {
    const client = new FakeChatClient({ friendships: [friendship(ALICE, BOB)] });
    const limiter = new StubRateLimiter(ALLOW);
    const service = makeService(client, limiter);
    await expect(service.sendMessage(ALICE, ALICE, 'echo?')).rejects.toMatchObject({
      code: 'self',
    });
    expect(client.fromCalls).toEqual([]);
    expect(limiter.keys).toEqual([]);
  });

  it('rate-limited: pesan memuat retryAfterMs, properti retryAfterMs terisi, NOL kueri', async () => {
    const client = new FakeChatClient({ friendships: [friendship(ALICE, BOB)] });
    const limiter = new StubRateLimiter({ allowed: false, remaining: 0, retryAfterMs: 1234 });
    const service = makeService(client, limiter);

    const error = await captureError(() => service.sendMessage(ALICE, BOB, 'halo'));

    expect(error).toBeInstanceOf(ChatError);
    expect(error).toMatchObject({
      code: 'rate-limited',
      retryAfterMs: 1234,
      message: expect.stringContaining('1234'),
    });
    expect(limiter.keys).toEqual([ALICE]);
    expect(client.fromCalls).toEqual([]); // supabase TIDAK disentuh sama sekali
    expect(client.selectCalls).toEqual([]);
    expect(client.insertCalls).toEqual([]);
  });

  it('not-friends: tanpa baris friendship maupun masih pending', async () => {
    const empty = new FakeChatClient();
    const serviceEmpty = makeService(empty);
    await expect(serviceEmpty.sendMessage(ALICE, BOB, 'halo')).rejects.toMatchObject({
      code: 'not-friends',
    });
    expect(empty.insertCalls).toEqual([]);

    const pending = new FakeChatClient({ friendships: [friendship(ALICE, BOB, 'pending')] });
    const servicePending = makeService(pending);
    await expect(servicePending.sendMessage(ALICE, BOB, 'halo')).rejects.toMatchObject({
      code: 'not-friends',
    });
    expect(pending.insertCalls).toEqual([]);
  });

  it('error DB "message rejected: blocked" dipetakan ke blocked (trigger 0009)', async () => {
    const dbError = { message: 'message rejected: blocked', code: 'P0001' };
    const client = new FakeChatClient({
      friendships: [friendship(ALICE, BOB)],
      failInsertWith: dbError,
    });
    const service = makeService(client);
    await expect(service.sendMessage(ALICE, BOB, 'halo')).rejects.toMatchObject({
      code: 'blocked',
      cause: dbError,
    });
  });

  it('error DB "RATE_LIMITED_MESSAGES" (trigger 0019) dipetakan ke rate-limited + retryAfterMs 10 detik', async () => {
    const dbError = { message: 'RATE_LIMITED_MESSAGES', code: 'P0001' };
    const client = new FakeChatClient({
      friendships: [friendship(ALICE, BOB)],
      failInsertWith: dbError,
    });
    const service = makeService(client);

    const error = await captureError(() => service.sendMessage(ALICE, BOB, 'halo'));

    // Rate limiter LOKAL mengizinkan (stub ALLOW) — ini justru jalurnya:
    // limit client bisa di-bypass (tab ganda/skrip), server yang menampar.
    expect(error).toBeInstanceOf(ChatError);
    expect(error).toMatchObject({
      code: 'rate-limited',
      retryAfterMs: 10_000,
      cause: dbError,
    });
    // Pesan bawaan tidak membocorkan pesan/errcode mentah server.
    expect(error).toMatchObject({ message: expect.stringContaining('10 detik') });
    expect(error).toMatchObject({ message: expect.not.stringContaining('P0001') });
  });

  it('error DB code 23514 (check_violation) dipetakan ke self', async () => {
    const client = new FakeChatClient({
      friendships: [friendship(ALICE, BOB)],
      failInsertWith: {
        message: 'new row violates check constraint "messages_no_self"',
        code: '23514',
      },
    });
    const service = makeService(client);
    await expect(service.sendMessage(ALICE, BOB, 'halo')).rejects.toMatchObject({
      code: 'self',
    });
  });

  it('error insert lain dibungkus db-error + cause asli', async () => {
    const dbError = { message: 'JWT expired', statusCode: '401' };
    const client = new FakeChatClient({
      friendships: [friendship(ALICE, BOB)],
      failInsertWith: dbError,
    });
    const service = makeService(client);
    await expect(service.sendMessage(ALICE, BOB, 'halo')).rejects.toMatchObject({
      code: 'db-error',
      message: expect.stringContaining('JWT expired'),
      cause: dbError,
    });
  });

  it('baris hasil insert yang rusak ditolak invalid-row (revalidasi Zod)', async () => {
    const client = new FakeChatClient({
      friendships: [friendship(ALICE, BOB)],
      makeId: () => 'bukan-uuid',
    });
    const service = makeService(client);
    await expect(service.sendMessage(ALICE, BOB, 'halo')).rejects.toMatchObject({
      code: 'invalid-row',
    });
  });

  it('error kueri gate pertemanan dibungkus db-error, insert tidak terjadi', async () => {
    const client = new FakeChatClient({
      friendships: [friendship(ALICE, BOB)],
      failSelectWith: { message: 'relation friendships does not exist' },
    });
    const service = makeService(client);
    await expect(service.sendMessage(ALICE, BOB, 'halo')).rejects.toMatchObject({
      code: 'db-error',
      message: expect.stringContaining('pertemanan'),
    });
    expect(client.insertCalls).toEqual([]);
  });

  it('rate limiter default aktif tanpa injeksi: 10 pesan lalu ke-11 ditolak', async () => {
    const client = new FakeChatClient({
      friendships: [friendship(ALICE, BOB), friendship(BOB, CAROL)],
    });
    const service = new MessageService({ supabase: client });

    for (let i = 0; i < 10; i += 1) {
      const message = await service.sendMessage(ALICE, BOB, `pesan ${i}`);
      expect(message.body).toBe(`pesan ${i}`);
    }
    await expect(service.sendMessage(ALICE, BOB, 'ke-11')).rejects.toMatchObject({
      code: 'rate-limited',
    });
    // Kunci = pengirim: BOB tidak terpengaruh jendela ALICE.
    const fromBob = await service.sendMessage(BOB, CAROL, 'dari bob');
    expect(fromBob.senderId).toBe(BOB);
    expect(client.insertCalls).toHaveLength(11);
  });
});

describe('MessageService.listConversation', () => {
  function seedConversation(): MessageRow[] {
    return [
      messageRow(ALICE, BOB, 'pesan 1', '2026-09-28T10:00:00Z'),
      messageRow(BOB, ALICE, 'pesan 2', '2026-09-28T10:00:01Z'),
      messageRow(ALICE, BOB, 'pesan 3', '2026-09-28T10:00:02Z'),
      messageRow(ALICE, CAROL, 'orang lain', '2026-09-28T10:00:03Z'),
      messageRow(CAROL, BOB, 'orang lain juga', '2026-09-28T10:00:04Z'),
      messageRow(BOB, ALICE, 'pesan 4', '2026-09-28T10:00:05Z'),
    ];
  }

  it('mengembalikan hanya pasangan dua arah, ASCENDING, tanpa menyentuh rate limiter', async () => {
    const client = new FakeChatClient({ messages: seedConversation() });
    const limiter = new StubRateLimiter(ALLOW);
    const service = makeService(client, limiter);

    const fromAlice = await service.listConversation(ALICE, BOB);
    expect(fromAlice.map((m) => m.body)).toEqual(['pesan 1', 'pesan 2', 'pesan 3', 'pesan 4']);
    expect(fromAlice.map((m) => m.createdAt)).toEqual([
      '2026-09-28T10:00:00Z',
      '2026-09-28T10:00:01Z',
      '2026-09-28T10:00:02Z',
      '2026-09-28T10:00:05Z',
    ]);

    // Dari sisi Bob: pasangan yang sama.
    const fromBob = await service.listConversation(BOB, ALICE);
    expect(fromBob.map((m) => m.id)).toEqual(fromAlice.map((m) => m.id));

    expect(limiter.keys).toEqual([]);
    expect(client.selectCalls).toEqual([
      {
        table: 'messages',
        or: `and(sender_id.eq.${ALICE},recipient_id.eq.${BOB}),and(sender_id.eq.${BOB},recipient_id.eq.${ALICE})`,
        eq: {},
        lt: {},
        order: { column: 'created_at', ascending: false },
        limit: 50,
        maybeSingle: false,
      },
      {
        table: 'messages',
        or: `and(sender_id.eq.${BOB},recipient_id.eq.${ALICE}),and(sender_id.eq.${ALICE},recipient_id.eq.${BOB})`,
        eq: {},
        lt: {},
        order: { column: 'created_at', ascending: false },
        limit: 50,
        maybeSingle: false,
      },
    ]);
  });

  it('limit mengambil N TERBARU lalu tetap dikembalikan ASCENDING', async () => {
    const client = new FakeChatClient({ messages: seedConversation() });
    const service = makeService(client);
    const messages = await service.listConversation(ALICE, BOB, { limit: 2 });
    expect(messages.map((m) => m.body)).toEqual(['pesan 3', 'pesan 4']);
  });

  it('limit di-clamp: 0 → 1, pecahan dilantai, di atas maksimum → 200, NaN → default 50', async () => {
    const client = new FakeChatClient({ messages: seedConversation() });
    const service = makeService(client);
    await service.listConversation(ALICE, BOB, { limit: 0 });
    await service.listConversation(ALICE, BOB, { limit: 7.5 });
    await service.listConversation(ALICE, BOB, { limit: 9999 });
    await service.listConversation(ALICE, BOB, { limit: Number.NaN });
    expect(client.selectCalls.map((call) => call.limit)).toEqual([1, 7, 200, 50]);
  });

  it('before membatasi created_at < kursor (ketat, pesan tepat di kursor dikecualikan)', async () => {
    const client = new FakeChatClient({ messages: seedConversation() });
    const service = makeService(client);
    const messages = await service.listConversation(ALICE, BOB, {
      before: '2026-09-28T10:00:02Z',
    });
    expect(messages.map((m) => m.body)).toEqual(['pesan 1', 'pesan 2']);
    expect(client.selectCalls[0]?.lt).toEqual({ created_at: '2026-09-28T10:00:02Z' });
  });

  it('before + limit bekerja sama (halaman kedua percakapan)', async () => {
    const client = new FakeChatClient({ messages: seedConversation() });
    const service = makeService(client);
    const pageTwo = await service.listConversation(ALICE, BOB, {
      limit: 2,
      before: '2026-09-28T10:00:02Z',
    });
    expect(pageTwo.map((m) => m.body)).toEqual(['pesan 1', 'pesan 2']);
    const pageOne = await service.listConversation(ALICE, BOB, { limit: 2 });
    expect(pageOne.map((m) => m.body)).toEqual(['pesan 3', 'pesan 4']);
  });

  it('before bukan ISO valid ditolak invalid-cursor sebelum kueri', async () => {
    const client = new FakeChatClient({ messages: seedConversation() });
    const service = makeService(client);
    await expect(service.listConversation(ALICE, BOB, { before: 'kemarin' })).rejects.toMatchObject(
      { code: 'invalid-cursor' },
    );
    await expect(service.listConversation(ALICE, BOB, { before: '' })).rejects.toMatchObject({
      code: 'invalid-cursor',
    });
    expect(client.fromCalls).toEqual([]);
  });

  it('uuid tidak valid dan percakapan dengan diri sendiri ditolak', async () => {
    const client = new FakeChatClient({ messages: seedConversation() });
    const service = makeService(client);
    await expect(service.listConversation('bukan-uuid', BOB)).rejects.toMatchObject({
      code: 'invalid-uuid',
    });
    await expect(service.listConversation(ALICE, ALICE)).rejects.toMatchObject({
      code: 'self',
    });
    expect(client.fromCalls).toEqual([]);
  });

  it('error kueri dibungkus db-error', async () => {
    const client = new FakeChatClient({
      messages: seedConversation(),
      failSelectWith: { message: 'network down' },
    });
    const service = makeService(client);
    await expect(service.listConversation(ALICE, BOB)).rejects.toMatchObject({
      code: 'db-error',
      message: expect.stringContaining('network down'),
    });
  });

  it('baris rusak membuat seluruh hasil invalid-row — TIDAK dibuang diam-diam', async () => {
    const good = seedConversation().slice(0, 2);
    const bad = {
      ...messageRow(ALICE, BOB, 'rusak', '2026-09-28T10:00:05Z'),
      body: 'x'.repeat(501),
    } as unknown as MessageRow;
    const client = new FakeChatClient({ messages: [...good, bad] });
    const service = makeService(client);
    await expect(service.listConversation(ALICE, BOB)).rejects.toMatchObject({
      code: 'invalid-row',
    });
  });
});
