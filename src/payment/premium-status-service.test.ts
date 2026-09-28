import { describe, expect, it } from 'vitest';
import { PremiumStatusService } from './premium-status-service';
import { FakePremiumClient } from './test-utils';
import { PremiumProfileRowSchema, type PremiumProfileRow } from './types';

const USER = '7db26a0a-9ce5-4558-bd08-9612e9e9febe';

function row(overrides: Partial<PremiumProfileRow> = {}): PremiumProfileRow {
  return { id: USER, is_premium: false, ...overrides };
}

function setup(rows: PremiumProfileRow[] = [row()]) {
  const client = new FakePremiumClient({ rows });
  const service = new PremiumStatusService({ supabase: client });
  return { client, service };
}

describe('PremiumStatusService.getPremiumStatus', () => {
  it('mengembalikan status non-premium dalam bentuk camelCase', async () => {
    const { service } = setup([row({ is_premium: false })]);
    expect(await service.getPremiumStatus(USER)).toEqual({
      userId: USER,
      isPremium: false,
    });
  });

  it('mengembalikan status premium', async () => {
    const { service } = setup([row({ is_premium: true })]);
    expect(await service.getPremiumStatus(USER)).toEqual({
      userId: USER,
      isPremium: true,
    });
  });

  it('memakai rantai persis kontrak: select("id,is_premium").eq("id", userId).maybeSingle()', async () => {
    const { client, service } = setup();
    await service.getPremiumStatus(USER);
    expect(client.selectCalls).toEqual([{ table: 'profiles', columns: 'id,is_premium' }]);
    expect(client.eqFilters).toEqual([{ id: USER }]);
  });

  it('mengembalikan null bila baris tidak ada', async () => {
    const { service } = setup([]);
    expect(await service.getPremiumStatus(USER)).toBeNull();
  });

  it('userId kosong ditolak', async () => {
    const { service } = setup();
    await expect(service.getPremiumStatus('')).rejects.toMatchObject({ code: 'not-signed-in' });
  });

  it('error kueri dibungkus profile-error (dengan cause)', async () => {
    const client = new FakePremiumClient({ failSelectWith: { message: 'JWT expired' } });
    const service = new PremiumStatusService({ supabase: client });
    await expect(service.getPremiumStatus(USER)).rejects.toMatchObject({
      code: 'profile-error',
      message: expect.stringContaining('JWT expired'),
      cause: { message: 'JWT expired' },
    });
  });

  it('baris rusak (is_premium bukan boolean) ditolak invalid-profile-row', async () => {
    const { service } = setup([{ id: USER, is_premium: 'yes' as unknown as boolean }]);
    await expect(service.getPremiumStatus(USER)).rejects.toMatchObject({
      code: 'invalid-profile-row',
    });
  });

  it('skema menolak id kosong / is_premium hilang (bukti langsung kontrak baris)', () => {
    expect(PremiumProfileRowSchema.safeParse({ id: '', is_premium: false }).success).toBe(false);
    expect(PremiumProfileRowSchema.safeParse({ id: USER }).success).toBe(false);
    expect(PremiumProfileRowSchema.safeParse({ id: USER, is_premium: true }).success).toBe(true);
  });
});
