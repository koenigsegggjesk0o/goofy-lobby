import { describe, expect, it } from 'vitest';
import {
  BLOCK_GUARD_MESSAGE,
  FRIENDSHIP_PROFILE_COLUMNS,
  FriendshipProfileSummarySchema,
  FriendshipRowSchema,
  FriendshipStatusSchema,
  BlockRowSchema,
  BlockedIdRowSchema,
  FriendsError,
  SummaryAvatarColorSchema,
  SummaryDisplayNameSchema,
  UuidSchema,
  assertUuid,
  canonicalPairFilter,
  participantFilter,
} from './types';

const ALPHA = '11111111-1111-4111-8111-111111111111';
const BRAVO = '22222222-2222-4222-8222-222222222222';

describe('UuidSchema (guard injection filter .or)', () => {
  it('menerima uuid v4 huruf kecil/besar', () => {
    expect(UuidSchema.safeParse(ALPHA).success).toBe(true);
    expect(UuidSchema.safeParse('7DB26A0A-9CE5-4558-BD08-9612E9E9FEBE').success).toBe(true);
  });

  it('menolak string kosong, biasa, dan payload injection', () => {
    expect(UuidSchema.safeParse('').success).toBe(false);
    expect(UuidSchema.safeParse('bukan-uuid').success).toBe(false);
    // Payload injection PostgREST: koma/parens/strip komentar tidak boleh
    // pernah lolos ke string filter .or.
    expect(UuidSchema.safeParse('A),and(1=1)--').success).toBe(false);
    expect(UuidSchema.safeParse('x.y,z).not.is.null').success).toBe(false);
    expect(UuidSchema.safeParse(123).success).toBe(false);
  });
});

describe('skema kolom ringkas', () => {
  it('SummaryDisplayNameSchema menerima 1–32 karakter dan memangkas', () => {
    expect(SummaryDisplayNameSchema.safeParse(' QA Alpha ').data).toBe('QA Alpha');
    expect(SummaryDisplayNameSchema.safeParse('x'.repeat(32)).success).toBe(true);
    expect(SummaryDisplayNameSchema.safeParse('').success).toBe(false);
    expect(SummaryDisplayNameSchema.safeParse('x'.repeat(33)).success).toBe(false);
  });

  it('SummaryAvatarColorSchema menerima #RRGGBB saja', () => {
    expect(SummaryAvatarColorSchema.safeParse('#9ca3af').success).toBe(true);
    expect(SummaryAvatarColorSchema.safeParse('#ABCDEF').success).toBe(true);
    expect(SummaryAvatarColorSchema.safeParse('9ca3af').success).toBe(false);
    expect(SummaryAvatarColorSchema.safeParse('#gggggg').success).toBe(false);
  });
});

describe('FriendshipStatusSchema', () => {
  it('hanya menerima pending/accepted (persis CHECK 0007)', () => {
    expect(FriendshipStatusSchema.safeParse('pending').data).toBe('pending');
    expect(FriendshipStatusSchema.safeParse('accepted').data).toBe('accepted');
    expect(FriendshipStatusSchema.safeParse('rejected').success).toBe(false);
    expect(FriendshipStatusSchema.safeParse('').success).toBe(false);
  });
});

describe('FriendshipRowSchema', () => {
  const validRow = {
    id: '00000000-0000-4000-8000-000000000001',
    requester_id: ALPHA,
    addressee_id: BRAVO,
    status: 'pending',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };

  it('menerima baris valid', () => {
    expect(FriendshipRowSchema.safeParse(validRow).success).toBe(true);
  });

  it('menolak status asing, id non-uuid, dan kolom hilang', () => {
    expect(FriendshipRowSchema.safeParse({ ...validRow, status: 'weird' }).success).toBe(false);
    expect(FriendshipRowSchema.safeParse({ ...validRow, id: 'bukan-uuid' }).success).toBe(false);
    expect(FriendshipRowSchema.safeParse({ ...validRow, addressee_id: undefined }).success).toBe(
      false,
    );
    expect(FriendshipRowSchema.safeParse({ ...validRow, updated_at: '' }).success).toBe(false);
  });
});

describe('BlockRowSchema & BlockedIdRowSchema', () => {
  it('menerima baris blocks valid', () => {
    expect(
      BlockRowSchema.safeParse({
        blocker_id: ALPHA,
        blocked_id: BRAVO,
        created_at: '2026-01-01T00:00:00.000Z',
      }).success,
    ).toBe(true);
  });

  it('menolak kolom hilang / id non-uuid', () => {
    expect(BlockRowSchema.safeParse({ blocker_id: ALPHA, blocked_id: BRAVO }).success).toBe(false);
    expect(
      BlockRowSchema.safeParse({ blocker_id: 'x', blocked_id: BRAVO, created_at: 't' }).success,
    ).toBe(false);
  });

  it('BlockedIdRowSchema memangkas kolom lain (proyeksi select blocked_id)', () => {
    const parsed = BlockedIdRowSchema.safeParse({
      blocker_id: ALPHA,
      blocked_id: BRAVO,
      created_at: '2026-01-01T00:00:00.000Z',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({ blocked_id: BRAVO });
    }
  });
});

describe('FriendshipProfileSummarySchema', () => {
  it('menerima baris ringkas dan memangkas kolom profil lain', () => {
    // Baris PENUH profile (snake_case) harus tetap lolos — membuktikan
    // skema mandiri ini kompatibel dengan hasil join profil sesungguhnya.
    const parsed = FriendshipProfileSummarySchema.safeParse({
      id: ALPHA,
      display_name: 'QA Alpha',
      avatar_color: '#9ca3af',
      voice_snippet_path: `${ALPHA}/snippet-a.webm`,
      created_at: '2026-09-27T10:00:00Z',
      updated_at: '2026-09-27T10:00:00Z',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Object.keys(parsed.data).sort()).toEqual(['avatar_color', 'display_name', 'id']);
    }
  });

  it('menolak nama kosong dan warna asing', () => {
    expect(
      FriendshipProfileSummarySchema.safeParse({
        id: ALPHA,
        display_name: '',
        avatar_color: '#9ca3af',
      }).success,
    ).toBe(false);
    expect(
      FriendshipProfileSummarySchema.safeParse({
        id: ALPHA,
        display_name: 'A',
        avatar_color: 'merah',
      }).success,
    ).toBe(false);
    expect(
      FriendshipProfileSummarySchema.safeParse({
        id: 'x',
        display_name: 'A',
        avatar_color: '#9ca3af',
      }).success,
    ).toBe(false);
  });
});

describe('assertUuid', () => {
  it('mengembalikan nilai yang valid', () => {
    expect(assertUuid(ALPHA, 'userId')).toBe(ALPHA);
  });

  it('melempar FriendsError invalid-user-id dengan cause isu Zod', () => {
    try {
      assertUuid('A),and(1=1)--', 'addresseeId');
      expect.unreachable('harus melempar');
    } catch (error) {
      expect(error).toBeInstanceOf(FriendsError);
      const friendsError = error as FriendsError;
      expect(friendsError.code).toBe('invalid-user-id');
      expect(friendsError.name).toBe('FriendsError');
      expect(friendsError.message).toContain('addresseeId');
      expect(Array.isArray(friendsError.cause)).toBe(true);
    }
  });
});

describe('canonicalPairFilter', () => {
  it('menyusun filter dua-and persis kontrak PostgREST', () => {
    expect(canonicalPairFilter(ALPHA, BRAVO)).toBe(
      `and(requester_id.eq.${ALPHA},addressee_id.eq.${BRAVO}),and(requester_id.eq.${BRAVO},addressee_id.eq.${ALPHA})`,
    );
  });

  it('simetris: argumen tertukar menghasilkan filter yang sama', () => {
    expect(canonicalPairFilter(BRAVO, ALPHA)).toBe(canonicalPairFilter(ALPHA, BRAVO));
  });

  it('menolak argumen non-uuid (choke point anti-injection)', () => {
    expect(() => canonicalPairFilter(ALPHA, 'x),or(1=1')).toThrow(FriendsError);
    expect(() => canonicalPairFilter("' || '1'='1", BRAVO)).toThrow(FriendsError);
  });
});

describe('participantFilter', () => {
  it('menyusun filter peserta requester/addressee', () => {
    expect(participantFilter(ALPHA)).toBe(`requester_id.eq.${ALPHA},addressee_id.eq.${ALPHA}`);
  });

  it('menolak argumen non-uuid', () => {
    expect(() => participantFilter('bukan-uuid')).toThrow(FriendsError);
  });
});

describe('konstanta kontrak', () => {
  it('proyeksi kolom profil terkunci eksplisit', () => {
    expect(FRIENDSHIP_PROFILE_COLUMNS).toBe('id, display_name, avatar_color');
  });

  it('pesan trigger block guard persis migrasi 0007', () => {
    expect(BLOCK_GUARD_MESSAGE).toBe('friend request rejected: blocked');
  });
});
