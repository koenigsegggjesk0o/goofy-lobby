import { describe, expect, it } from 'vitest';
import { BlockService } from './block-service';
import { FakeFriendsClient } from './test-utils';
import type { FakeFriendsClientOptions } from './test-utils';
import type { BlockRow, FriendshipProfileSummaryRow } from './types';

// User uji — uuid v4 bentuk stabil (ALPHA < BRAVO < CHARLIE leksikografis).
const ALPHA = '11111111-1111-4111-8111-111111111111';
const BRAVO = '22222222-2222-4222-8222-222222222222';
const CHARLIE = '33333333-3333-4333-8333-333333333333';

/** Baris blocks default: ALPHA memblokir BRAVO (bentuk snake_case DB). */
function block(overrides: Partial<BlockRow> = {}): BlockRow {
  return {
    blocker_id: ALPHA,
    blocked_id: BRAVO,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Profil ringkas (proyeksi join) untuk user terblokir. */
function profile(id: string, displayName: string): FriendshipProfileSummaryRow {
  return { id, display_name: displayName, avatar_color: '#9ca3af' };
}

function setup(options: FakeFriendsClientOptions = {}) {
  const client = new FakeFriendsClient(options);
  const service = new BlockService({ supabase: client });
  return { client, service };
}

describe('BlockService.blockUser', () => {
  it('happy path: upsert ignoreDuplicates + baris tersimpan', async () => {
    const { client, service } = setup();
    await service.blockUser(ALPHA, BRAVO);
    // Jam fake deterministik: t0 = 2026-01-01T00:00:00Z.
    expect(client.blocks).toEqual([
      { blocker_id: ALPHA, blocked_id: BRAVO, created_at: '2026-01-01T00:00:00.000Z' },
    ]);
    expect(client.upsertCalls).toEqual([
      {
        table: 'blocks',
        values: { blocker_id: ALPHA, blocked_id: BRAVO },
        ignoreDuplicates: true,
      },
    ]);
  });

  it('idempoten: blok kedua kali tetap sukses dan tetap satu baris', async () => {
    const { client, service } = setup();
    await service.blockUser(ALPHA, BRAVO);
    await service.blockUser(ALPHA, BRAVO);
    expect(client.blocks).toHaveLength(1);
    expect(client.upsertCalls).toHaveLength(2);
  });

  it('memblokir diri sendiri ditolak lokal sebelum kueri', async () => {
    const { client, service } = setup();
    await expect(service.blockUser(ALPHA, ALPHA)).rejects.toMatchObject({
      code: 'self-block',
    });
    expect(client.upsertCalls).toHaveLength(0);
    expect(client.blocks).toHaveLength(0);
  });

  it('id user tidak valid ditolak sebelum kueri', async () => {
    const { client, service } = setup();
    await expect(service.blockUser('x),or(1=1)', BRAVO)).rejects.toMatchObject({
      code: 'invalid-user-id',
    });
    await expect(service.blockUser(ALPHA, 'bukan-uuid')).rejects.toMatchObject({
      code: 'invalid-user-id',
    });
    expect(client.upsertCalls).toHaveLength(0);
  });

  it('error upsert → db-error + cause', async () => {
    const { service } = setup({ failUpsertWith: { message: 'storage offline' } });
    await expect(service.blockUser(ALPHA, BRAVO)).rejects.toMatchObject({
      code: 'db-error',
      message: expect.stringContaining('storage offline'),
      cause: { message: 'storage offline' },
    });
  });
});

describe('BlockService.unblockUser', () => {
  it('happy path: menghapus pasangan blokir milik blocker', async () => {
    const { client, service } = setup({ blocks: [block()] });
    await service.unblockUser(ALPHA, BRAVO);
    expect(client.blocks).toHaveLength(0);
    expect(client.deleteCalls).toEqual([
      { table: 'blocks', eq: { blocker_id: ALPHA, blocked_id: BRAVO }, or: null },
    ]);
  });

  it('blokir tidak ada → not-found', async () => {
    const { client, service } = setup();
    await expect(service.unblockUser(ALPHA, BRAVO)).rejects.toMatchObject({
      code: 'not-found',
    });
    expect(client.blocks).toHaveLength(0);
  });

  it('blokir milik user lain → not-found (blokir asli tidak tersentuh)', async () => {
    const { client, service } = setup({ blocks: [block()] });
    await expect(service.unblockUser(CHARLIE, BRAVO)).rejects.toMatchObject({
      code: 'not-found',
    });
    expect(client.blocks).toEqual([block()]);
  });

  it('error delete → db-error + cause', async () => {
    const { service } = setup({
      blocks: [block()],
      failDeleteWith: { message: 'storage down' },
    });
    await expect(service.unblockUser(ALPHA, BRAVO)).rejects.toMatchObject({
      code: 'db-error',
      cause: { message: 'storage down' },
    });
  });
});

describe('BlockService.listBlockedProfiles', () => {
  const T1 = '2026-01-01T00:00:01.000Z';
  const T2 = '2026-01-01T00:00:02.000Z';
  const T3 = '2026-01-01T00:00:03.000Z';

  function setupBlocks() {
    return setup({
      blocks: [
        block({ blocked_id: BRAVO, created_at: T1 }),
        block({ blocked_id: CHARLIE, created_at: T2 }),
        // Blokir milik user lain — terkecuali (RLS blocker-only).
        { blocker_id: BRAVO, blocked_id: ALPHA, created_at: T3 },
      ],
      profiles: [profile(BRAVO, 'Bravo'), profile(CHARLIE, 'Charlie')],
    });
  }

  it('hanya blokir blocker + profil ringkas + terbaru dulu', async () => {
    const { service } = setupBlocks();
    const entries = await service.listBlockedProfiles(ALPHA);
    expect(entries).toEqual([
      {
        blockedId: CHARLIE,
        since: T2,
        profile: { id: CHARLIE, displayName: 'Charlie', avatarColor: '#9ca3af' },
      },
      {
        blockedId: BRAVO,
        since: T1,
        profile: { id: BRAVO, displayName: 'Bravo', avatarColor: '#9ca3af' },
      },
    ]);
  });

  it('tanpa blokir → daftar kosong', async () => {
    const { service } = setup();
    expect(await service.listBlockedProfiles(ALPHA)).toEqual([]);
  });

  it('baris blokir rusak hasil kueri → invalid-row', async () => {
    const { service } = setup({ blocks: [block({ created_at: '' })] });
    await expect(service.listBlockedProfiles(ALPHA)).rejects.toMatchObject({
      code: 'invalid-row',
    });
  });

  it('profil user terblokir hilang dari batch → invalid-row', async () => {
    const { service } = setup({ blocks: [block()], profiles: [] });
    await expect(service.listBlockedProfiles(ALPHA)).rejects.toMatchObject({
      code: 'invalid-row',
    });
  });

  it('error select → db-error + cause', async () => {
    const { service } = setup({ failSelectWith: { message: 'gateway timeout' } });
    await expect(service.listBlockedProfiles(ALPHA)).rejects.toMatchObject({
      code: 'db-error',
      cause: { message: 'gateway timeout' },
    });
  });
});

describe('BlockService.getBlockedUserIds', () => {
  it('mengembalikan id yang diblokir (proyeksi blocked_id)', async () => {
    const { service } = setup({
      blocks: [
        block({ blocked_id: BRAVO, created_at: '2026-01-01T00:00:01.000Z' }),
        block({ blocked_id: CHARLIE, created_at: '2026-01-01T00:00:02.000Z' }),
        { blocker_id: BRAVO, blocked_id: ALPHA, created_at: '2026-01-01T00:00:03.000Z' },
      ],
    });
    const ids = await service.getBlockedUserIds(ALPHA);
    // Tanpa clause order — kontrak hanya himpunan id, bukan urutan.
    expect(ids).toEqual(expect.arrayContaining([BRAVO, CHARLIE]));
    expect(ids).toHaveLength(2);
  });

  it('tanpa blokir → daftar kosong', async () => {
    const { service } = setup();
    expect(await service.getBlockedUserIds(ALPHA)).toEqual([]);
  });

  it('error select → db-error + cause', async () => {
    const { service } = setup({ failSelectWith: { message: 'dns failure' } });
    await expect(service.getBlockedUserIds(ALPHA)).rejects.toMatchObject({
      code: 'db-error',
      cause: { message: 'dns failure' },
    });
  });
});
