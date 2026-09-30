import { describe, expect, it } from 'vitest';
import { FriendshipService } from './friendship-service';
import { FakeFriendsClient } from './test-utils';
import type { FakeFriendsClientOptions } from './test-utils';
import { BLOCK_GUARD_MESSAGE, FriendsError } from './types';
import type { BlockRow, FriendshipProfileSummaryRow, FriendshipRow } from './types';

// User uji — uuid v4 bentuk stabil (id << urutan leksikografis ALPHA < BRAVO
// < CHARLIE < DELTA, penting untuk kasus pasangan kanonik).
const ALPHA = '11111111-1111-4111-8111-111111111111';
const BRAVO = '22222222-2222-4222-8222-222222222222';
const CHARLIE = '33333333-3333-4333-8333-333333333333';
const DELTA = '44444444-4444-4444-8444-444444444444';
const REQUEST_ID = '00000000-0000-4000-8000-000000000001';

/** Baris friendships default: ALPHA → BRAVO pending (bentuk snake_case DB). */
function friendship(overrides: Partial<FriendshipRow> = {}): FriendshipRow {
  return {
    id: REQUEST_ID,
    requester_id: ALPHA,
    addressee_id: BRAVO,
    status: 'pending',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Profil ringkas (proyeksi FRIENDSHIP_PROFILE_COLUMNS) untuk join lawan. */
function profile(id: string, displayName: string): FriendshipProfileSummaryRow {
  return { id, display_name: displayName, avatar_color: '#9ca3af' };
}

function setup(options: FakeFriendsClientOptions = {}) {
  const client = new FakeFriendsClient(options);
  const service = new FriendshipService({ supabase: client });
  return { client, service };
}

describe('FriendshipService.sendFriendRequest', () => {
  it('happy path: menyimpan baris pending dan mengembalikan bentuk camelCase', async () => {
    const { client, service } = setup();
    const created = await service.sendFriendRequest(ALPHA, BRAVO);
    // Jam & id fake deterministik: t0 = 2026-01-01T00:00:00Z, id counter #1.
    expect(created).toEqual({
      id: '00000000-0000-4000-8000-000000000001',
      requesterId: ALPHA,
      addresseeId: BRAVO,
      status: 'pending',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(client.friendships).toHaveLength(1);
    expect(client.insertCalls).toEqual([
      {
        table: 'friendships',
        values: { requester_id: ALPHA, addressee_id: BRAVO, status: 'pending' },
      },
    ]);
  });

  it('permintaan ke diri sendiri ditolak lokal sebelum kueri', async () => {
    const { client, service } = setup();
    await expect(service.sendFriendRequest(ALPHA, ALPHA)).rejects.toThrow(FriendsError);
    await expect(service.sendFriendRequest(ALPHA, ALPHA)).rejects.toMatchObject({
      code: 'self-request',
    });
    expect(client.insertCalls).toHaveLength(0);
    expect(client.friendships).toHaveLength(0);
  });

  it('id user tidak valid ditolak sebelum kueri (guard injection)', async () => {
    const { client, service } = setup();
    await expect(service.sendFriendRequest('A),and(1=1)--', BRAVO)).rejects.toMatchObject({
      code: 'invalid-user-id',
    });
    await expect(service.sendFriendRequest(ALPHA, 'bukan-uuid')).rejects.toMatchObject({
      code: 'invalid-user-id',
    });
    expect(client.insertCalls).toHaveLength(0);
  });

  it('duplikat arah sama (A→B lalu A→B lagi) → request-exists arah outgoing', async () => {
    const { client, service } = setup({ friendships: [friendship()] });
    await expect(service.sendFriendRequest(ALPHA, BRAVO)).rejects.toMatchObject({
      code: 'request-exists',
      message: expect.stringContaining('outgoing'),
    });
    // Pra-cek kanonik mencegah insert kedua (unique index 0007 tidak tersentuh).
    expect(client.insertCalls).toHaveLength(0);
    expect(client.friendships).toHaveLength(1);
  });

  it('kanonik arah tertukar (A→B lalu B→A) → request-exists arah incoming', async () => {
    const { client, service } = setup({ friendships: [friendship()] });
    await expect(service.sendFriendRequest(BRAVO, ALPHA)).rejects.toMatchObject({
      code: 'request-exists',
      message: expect.stringContaining('incoming'),
    });
    expect(client.insertCalls).toHaveLength(0);
    expect(client.friendships).toHaveLength(1);
  });

  it('prima-cek menangkap baris arah terbalik (baris B→A, kirim A→B) → incoming', async () => {
    // Membuktikan filter .or dua-grup-and benar-benar mencocokkan kedua arah.
    const { service } = setup({
      friendships: [friendship({ requester_id: BRAVO, addressee_id: ALPHA })],
    });
    await expect(service.sendFriendRequest(ALPHA, BRAVO)).rejects.toMatchObject({
      code: 'request-exists',
      message: expect.stringContaining('incoming'),
    });
  });

  it('pasangan sudah accepted → already-friends kedua arah', async () => {
    const { service } = setup({ friendships: [friendship({ status: 'accepted' })] });
    await expect(service.sendFriendRequest(ALPHA, BRAVO)).rejects.toMatchObject({
      code: 'already-friends',
    });
    await expect(service.sendFriendRequest(BRAVO, ALPHA)).rejects.toMatchObject({
      code: 'already-friends',
    });
  });

  it('penerima telah memblokir pengirim → blocked (pesan trigger 0007 di cause)', async () => {
    const blocks: BlockRow[] = [
      { blocker_id: BRAVO, blocked_id: ALPHA, created_at: '2026-01-01T00:00:00.000Z' },
    ];
    const { client, service } = setup({ blocks });
    await expect(service.sendFriendRequest(ALPHA, BRAVO)).rejects.toMatchObject({
      code: 'blocked',
      cause: { message: BLOCK_GUARD_MESSAGE, code: 'P0001' },
    });
    expect(client.friendships).toHaveLength(0);
  });

  it('pengirim memblokir penerima (arah sebaliknya) → blocked (guard dua arah 0019)', async () => {
    // Sebelum 0019, request ini DITERIMA — blocker bisa mengirim request ke
    // korban blokirnya (temuan INFO 25-b). Sekarang kedua arah menolak.
    const blocks: BlockRow[] = [
      { blocker_id: ALPHA, blocked_id: BRAVO, created_at: '2026-01-01T00:00:00.000Z' },
    ];
    const { client, service } = setup({ blocks });
    await expect(service.sendFriendRequest(ALPHA, BRAVO)).rejects.toMatchObject({
      code: 'blocked',
      cause: { message: BLOCK_GUARD_MESSAGE, code: 'P0001' },
    });
    expect(client.friendships).toHaveLength(0);
  });

  it('rate limit server (trigger 0019, RATE_LIMITED_FRIENDSHIP) dipetakan rate-limited', async () => {
    const dbError = { message: 'RATE_LIMITED_FRIENDSHIP', code: 'P0001' };
    const { service } = setup({ failInsertWith: dbError });
    await expect(service.sendFriendRequest(ALPHA, BRAVO)).rejects.toMatchObject({
      code: 'rate-limited',
      cause: dbError,
    });
  });

  it('balapan insert unik (code 23505) dipetakan request-exists', async () => {
    const { service } = setup({
      failInsertWith: {
        code: '23505',
        message: 'duplicate key value violates unique constraint',
      },
    });
    await expect(service.sendFriendRequest(ALPHA, BRAVO)).rejects.toMatchObject({
      code: 'request-exists',
    });
  });

  it('CHECK no_self dari DB (code 23514) dipetakan self-request (jalur defensif)', async () => {
    const { service } = setup({
      failInsertWith: { code: '23514', message: 'violates check constraint' },
    });
    await expect(service.sendFriendRequest(ALPHA, BRAVO)).rejects.toMatchObject({
      code: 'self-request',
    });
  });

  it('error pra-cek select → db-error + cause, insert tidak jalan', async () => {
    const { client, service } = setup({ failSelectWith: { message: 'network unreachable' } });
    await expect(service.sendFriendRequest(ALPHA, BRAVO)).rejects.toMatchObject({
      code: 'db-error',
      message: expect.stringContaining('network unreachable'),
      cause: { message: 'network unreachable' },
    });
    expect(client.insertCalls).toHaveLength(0);
  });

  it('error insert lain → db-error + cause', async () => {
    const { service } = setup({ failInsertWith: { message: 'connection reset' } });
    await expect(service.sendFriendRequest(ALPHA, BRAVO)).rejects.toMatchObject({
      code: 'db-error',
      message: expect.stringContaining('connection reset'),
      cause: { message: 'connection reset' },
    });
  });
});

describe('FriendshipService.acceptFriendRequest', () => {
  it('happy path: penerima menerima → accepted, updated_at dibump trigger', async () => {
    const { client, service } = setup();
    const sent = await service.sendFriendRequest(ALPHA, BRAVO);
    const accepted = await service.acceptFriendRequest(BRAVO, sent.id);
    expect(accepted.status).toBe('accepted');
    expect(accepted.createdAt).toBe('2026-01-01T00:00:00.000Z');
    // Jam fake maju 1 detik per pemanggilan: update = t0 + 1s (trigger
    // friendships_set_updated_at 0007).
    expect(accepted.updatedAt).toBe('2026-01-01T00:00:01.000Z');
    expect(client.friendships[0]?.status).toBe('accepted');
    // Filter peran + status persis kontrak: hanya addressee baris pending.
    expect(client.updateCalls).toEqual([
      {
        table: 'friendships',
        values: { status: 'accepted' },
        eq: { id: sent.id, addressee_id: BRAVO, status: 'pending' },
      },
    ]);
  });

  it('accept oleh bukan addressee (outsider / pengirim) → not-found, baris tetap pending', async () => {
    const { client, service } = setup({ friendships: [friendship()] });
    await expect(service.acceptFriendRequest(CHARLIE, REQUEST_ID)).rejects.toMatchObject({
      code: 'not-found',
    });
    await expect(service.acceptFriendRequest(ALPHA, REQUEST_ID)).rejects.toMatchObject({
      code: 'not-found',
    });
    expect(client.friendships[0]?.status).toBe('pending');
  });

  it('accept requestId asing → not-found', async () => {
    const { service } = setup({ friendships: [friendship()] });
    await expect(
      service.acceptFriendRequest(BRAVO, '99999999-9999-4999-8999-999999999999'),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('accept baris yang sudah accepted → not-found (filter status pending)', async () => {
    const { service } = setup({ friendships: [friendship({ status: 'accepted' })] });
    await expect(service.acceptFriendRequest(BRAVO, REQUEST_ID)).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('error update (RLS/jaringan) dibungkus not-found + cause', async () => {
    const { service } = setup({ failUpdateWith: { message: 'RLS violation' } });
    await expect(service.acceptFriendRequest(BRAVO, REQUEST_ID)).rejects.toMatchObject({
      code: 'not-found',
      cause: { message: 'RLS violation' },
    });
  });

  it('error update INVALID_FRIENDSHIP_TRANSITION (trigger 0019) dipetakan invalid-transition, bukan not-found', async () => {
    const dbError = { message: 'INVALID_FRIENDSHIP_TRANSITION', code: 'P0001' };
    const { service } = setup({ failUpdateWith: dbError });
    await expect(service.acceptFriendRequest(BRAVO, REQUEST_ID)).rejects.toMatchObject({
      code: 'invalid-transition',
      cause: dbError,
    });
  });
});

describe('FriendshipService.decline / cancel / removeFriend', () => {
  it('decline: penerima menghapus baris pending', async () => {
    const { client, service } = setup({ friendships: [friendship()] });
    await service.declineFriendRequest(BRAVO, REQUEST_ID);
    expect(client.friendships).toHaveLength(0);
    expect(client.deleteCalls).toEqual([
      {
        table: 'friendships',
        eq: { id: REQUEST_ID, status: 'pending', addressee_id: BRAVO },
        or: null,
      },
    ]);
  });

  it('decline oleh pengirim (peran salah) → not-found, baris tetap', async () => {
    const { client, service } = setup({ friendships: [friendship()] });
    await expect(service.declineFriendRequest(ALPHA, REQUEST_ID)).rejects.toMatchObject({
      code: 'not-found',
    });
    expect(client.friendships).toHaveLength(1);
  });

  it('cancel: pengirim menghapus baris pending', async () => {
    const { client, service } = setup({ friendships: [friendship()] });
    await service.cancelFriendRequest(ALPHA, REQUEST_ID);
    expect(client.friendships).toHaveLength(0);
  });

  it('cancel oleh penerima (peran salah) → not-found', async () => {
    const { client, service } = setup({ friendships: [friendship()] });
    await expect(service.cancelFriendRequest(BRAVO, REQUEST_ID)).rejects.toMatchObject({
      code: 'not-found',
    });
    expect(client.friendships).toHaveLength(1);
  });

  it('unfriend: salah satu pihak menghapus baris accepted (filter peserta dua arah)', async () => {
    const asRequester = setup({ friendships: [friendship({ status: 'accepted' })] });
    await asRequester.service.removeFriend(ALPHA, REQUEST_ID);
    expect(asRequester.client.friendships).toHaveLength(0);
    // Pihak lawan (addressee) juga berhak menghapus — peran 'either'.
    const asAddressee = setup({ friendships: [friendship({ status: 'accepted' })] });
    await asAddressee.service.removeFriend(BRAVO, REQUEST_ID);
    expect(asAddressee.client.friendships).toHaveLength(0);
    expect(asAddressee.client.deleteCalls[0]?.or).toBe(
      `requester_id.eq.${BRAVO},addressee_id.eq.${BRAVO}`,
    );
  });

  it('unfriend baris pending → not-found (status tak cocok)', async () => {
    const { client, service } = setup({ friendships: [friendship()] });
    await expect(service.removeFriend(ALPHA, REQUEST_ID)).rejects.toMatchObject({
      code: 'not-found',
    });
    expect(client.friendships).toHaveLength(1);
  });

  it('unfriend oleh pihak luar → not-found, baris tetap', async () => {
    const { client, service } = setup({ friendships: [friendship({ status: 'accepted' })] });
    await expect(service.removeFriend(CHARLIE, REQUEST_ID)).rejects.toMatchObject({
      code: 'not-found',
    });
    expect(client.friendships).toHaveLength(1);
  });

  it('error delete → db-error + cause', async () => {
    const { service } = setup({
      friendships: [friendship({ status: 'accepted' })],
      failDeleteWith: { message: 'storage down' },
    });
    await expect(service.removeFriend(ALPHA, REQUEST_ID)).rejects.toMatchObject({
      code: 'db-error',
      cause: { message: 'storage down' },
    });
  });
});

describe('FriendshipService.getFriendshipState', () => {
  it('tanpa baris → none (termasuk pasangan diri sendiri)', async () => {
    const { service } = setup();
    expect(await service.getFriendshipState(ALPHA, BRAVO)).toBe('none');
    // Self-pair mustahil punya baris (CHECK 0007) — dikembalikan 'none'
    // apa adanya, bukan error.
    expect(await service.getFriendshipState(ALPHA, ALPHA)).toBe('none');
  });

  it('pending: outgoing untuk pengirim, incoming untuk penerima', async () => {
    const { service } = setup({ friendships: [friendship()] });
    expect(await service.getFriendshipState(ALPHA, BRAVO)).toBe('pending-outgoing');
    expect(await service.getFriendshipState(BRAVO, ALPHA)).toBe('pending-incoming');
  });

  it('accepted → friends kedua arah', async () => {
    const { service } = setup({ friendships: [friendship({ status: 'accepted' })] });
    expect(await service.getFriendshipState(ALPHA, BRAVO)).toBe('friends');
    expect(await service.getFriendshipState(BRAVO, ALPHA)).toBe('friends');
  });

  it('baris rusak hasil kueri → invalid-row', async () => {
    const { service } = setup({ friendships: [friendship({ created_at: '' })] });
    await expect(service.getFriendshipState(ALPHA, BRAVO)).rejects.toMatchObject({
      code: 'invalid-row',
    });
  });

  it('error select → db-error + cause', async () => {
    const { service } = setup({ failSelectWith: { message: 'gateway timeout' } });
    await expect(service.getFriendshipState(ALPHA, BRAVO)).rejects.toMatchObject({
      code: 'db-error',
      cause: { message: 'gateway timeout' },
    });
  });
});

describe('FriendshipService.listFriends', () => {
  const T1 = '2026-01-01T00:00:01.000Z';
  const T2 = '2026-01-01T00:00:02.000Z';
  const T3 = '2026-01-01T00:00:03.000Z';

  it('dua arah (requester & addressee) + profil lawan, urut sejak terlama', async () => {
    const { service } = setup({
      friendships: [
        // ALPHA sebagai requester (A→B accepted, terlama).
        friendship({ id: REQUEST_ID, status: 'accepted', created_at: T1, updated_at: T1 }),
        // ALPHA sebagai addressee (C→A accepted, terbaru).
        friendship({
          id: '00000000-0000-4000-8000-000000000002',
          requester_id: CHARLIE,
          addressee_id: ALPHA,
          status: 'accepted',
          created_at: T2,
          updated_at: T2,
        }),
        // Bukan peserta ALPHA — terkecuali.
        friendship({
          id: '00000000-0000-4000-8000-000000000003',
          requester_id: BRAVO,
          addressee_id: CHARLIE,
          status: 'accepted',
          created_at: T3,
          updated_at: T3,
        }),
        // Peserta ALPHA tapi masih pending — terkecuali.
        friendship({
          id: '00000000-0000-4000-8000-000000000004',
          requester_id: ALPHA,
          addressee_id: DELTA,
          status: 'pending',
          created_at: T3,
          updated_at: T3,
        }),
      ],
      profiles: [profile(BRAVO, 'Bravo'), profile(CHARLIE, 'Charlie'), profile(DELTA, 'Delta')],
    });
    const friends = await service.listFriends(ALPHA);
    expect(friends).toEqual([
      {
        friendshipId: REQUEST_ID,
        friendId: BRAVO,
        since: T1,
        profile: { id: BRAVO, displayName: 'Bravo', avatarColor: '#9ca3af' },
      },
      {
        friendshipId: '00000000-0000-4000-8000-000000000002',
        friendId: CHARLIE,
        since: T2,
        profile: { id: CHARLIE, displayName: 'Charlie', avatarColor: '#9ca3af' },
      },
    ]);
  });

  it('tanpa teman → daftar kosong', async () => {
    const { service } = setup();
    expect(await service.listFriends(ALPHA)).toEqual([]);
  });

  it('profil lawan hilang dari batch → invalid-row', async () => {
    const { service } = setup({
      friendships: [friendship({ status: 'accepted' })],
      profiles: [],
    });
    await expect(service.listFriends(ALPHA)).rejects.toMatchObject({ code: 'invalid-row' });
  });

  it('baris pertemanan rusak hasil kueri → invalid-row', async () => {
    const { service } = setup({
      friendships: [friendship({ status: 'accepted', created_at: '' })],
      profiles: [profile(BRAVO, 'Bravo')],
    });
    await expect(service.listFriends(ALPHA)).rejects.toMatchObject({ code: 'invalid-row' });
  });

  it('error select → db-error + cause', async () => {
    const { service } = setup({ failSelectWith: { message: 'dns failure' } });
    await expect(service.listFriends(ALPHA)).rejects.toMatchObject({
      code: 'db-error',
      cause: { message: 'dns failure' },
    });
  });
});

describe('FriendshipService.listIncomingRequests / listOutgoingRequests', () => {
  const T1 = '2026-01-01T00:00:01.000Z';
  const T2 = '2026-01-01T00:00:02.000Z';
  const T3 = '2026-01-01T00:00:03.000Z';

  function setupRequests() {
    return setup({
      friendships: [
        // Incoming untuk BRAVO dari ALPHA (terlama).
        friendship({ id: '00000000-0000-4000-8000-000000000001', created_at: T1, updated_at: T1 }),
        // Outgoing BRAVO → DELTA.
        friendship({
          id: '00000000-0000-4000-8000-000000000002',
          requester_id: BRAVO,
          addressee_id: DELTA,
          created_at: T2,
          updated_at: T2,
        }),
        // Incoming untuk BRAVO dari CHARLIE (terbaru).
        friendship({
          id: '00000000-0000-4000-8000-000000000003',
          requester_id: CHARLIE,
          addressee_id: BRAVO,
          created_at: T3,
          updated_at: T3,
        }),
        // Permintaan orang lain — bukan urusan BRAVO.
        friendship({
          id: '00000000-0000-4000-8000-000000000004',
          requester_id: ALPHA,
          addressee_id: CHARLIE,
          created_at: T3,
          updated_at: T3,
        }),
      ],
      profiles: [profile(ALPHA, 'Alpha'), profile(CHARLIE, 'Charlie'), profile(DELTA, 'Delta')],
    });
  }

  it('incoming: hanya addressee pending + profil pengirim + terbaru dulu', async () => {
    const { service } = setupRequests();
    const incoming = await service.listIncomingRequests(BRAVO);
    expect(incoming).toEqual([
      {
        friendshipId: '00000000-0000-4000-8000-000000000003',
        requesterId: CHARLIE,
        addresseeId: BRAVO,
        createdAt: T3,
        profile: { id: CHARLIE, displayName: 'Charlie', avatarColor: '#9ca3af' },
      },
      {
        friendshipId: '00000000-0000-4000-8000-000000000001',
        requesterId: ALPHA,
        addresseeId: BRAVO,
        createdAt: T1,
        profile: { id: ALPHA, displayName: 'Alpha', avatarColor: '#9ca3af' },
      },
    ]);
  });

  it('outgoing: hanya requester pending + profil penerima', async () => {
    const { service } = setupRequests();
    const outgoing = await service.listOutgoingRequests(BRAVO);
    expect(outgoing).toEqual([
      {
        friendshipId: '00000000-0000-4000-8000-000000000002',
        requesterId: BRAVO,
        addresseeId: DELTA,
        createdAt: T2,
        profile: { id: DELTA, displayName: 'Delta', avatarColor: '#9ca3af' },
      },
    ]);
  });

  it('tanpa permintaan → daftar kosong', async () => {
    const { service } = setup();
    expect(await service.listIncomingRequests(ALPHA)).toEqual([]);
    expect(await service.listOutgoingRequests(ALPHA)).toEqual([]);
  });

  it('baris permintaan rusak → invalid-row', async () => {
    const { service } = setup({ friendships: [friendship({ created_at: '' })] });
    await expect(service.listIncomingRequests(BRAVO)).rejects.toMatchObject({
      code: 'invalid-row',
    });
  });

  it('error select → db-error + cause', async () => {
    const { service } = setup({ failSelectWith: { message: 'socket hang up' } });
    await expect(service.listOutgoingRequests(ALPHA)).rejects.toMatchObject({
      code: 'db-error',
      cause: { message: 'socket hang up' },
    });
  });
});
