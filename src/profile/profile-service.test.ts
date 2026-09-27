import { describe, expect, it } from 'vitest';
import { ProfileService } from './profile-service';
import { FakeProfileClient } from './test-utils';
import type { ProfileRow } from './types';

const USER = '7db26a0a-9ce5-4558-bd08-9612e9e9febe';

function row(overrides: Partial<ProfileRow> = {}): ProfileRow {
  return {
    id: USER,
    display_name: 'QA Alpha',
    avatar_color: '#9ca3af',
    voice_snippet_path: null,
    created_at: '2026-09-27T10:00:00Z',
    updated_at: '2026-09-27T10:00:00Z',
    ...overrides,
  };
}

function setup(rows: ProfileRow[] = [row()]) {
  const client = new FakeProfileClient({ rows });
  const service = new ProfileService({ supabase: client });
  return { client, service };
}

describe('ProfileService.getProfile', () => {
  it('mengembalikan profil tervalidasi dalam bentuk camelCase', async () => {
    const { service } = setup([row({ voice_snippet_path: `${USER}/snippet-a.webm` })]);
    const profile = await service.getProfile(USER);
    expect(profile).toEqual({
      id: USER,
      displayName: 'QA Alpha',
      avatarColor: '#9ca3af',
      voiceSnippetPath: `${USER}/snippet-a.webm`,
      createdAt: '2026-09-27T10:00:00Z',
      updatedAt: '2026-09-27T10:00:00Z',
    });
  });

  it('mengembalikan null bila baris tidak ada', async () => {
    const { service } = setup([]);
    expect(await service.getProfile(USER)).toBeNull();
  });

  it('userId kosong ditolak', async () => {
    const { service } = setup();
    await expect(service.getProfile('')).rejects.toMatchObject({ code: 'not-signed-in' });
  });

  it('error kueri dibungkus profile-error', async () => {
    const client = new FakeProfileClient({ failSelectWith: { message: 'JWT expired' } });
    const service = new ProfileService({ supabase: client });
    await expect(service.getProfile(USER)).rejects.toMatchObject({
      code: 'profile-error',
      message: expect.stringContaining('JWT expired'),
    });
  });

  it('baris jahat (path asing / nama kepanjangan) ditolak invalid-profile-row', async () => {
    const { service } = setup([row({ voice_snippet_path: '../evil' as string })]);
    await expect(service.getProfile(USER)).rejects.toMatchObject({ code: 'invalid-profile-row' });
    const { service: service2 } = setup([row({ display_name: 'x'.repeat(40) })]);
    await expect(service2.getProfile(USER)).rejects.toMatchObject({
      code: 'invalid-profile-row',
    });
  });
});

describe('ProfileService.updateProfile', () => {
  it('hanya mengirim kolom yang diisi (whitelist snake_case)', async () => {
    const { client, service } = setup();
    const profile = await service.updateProfile(USER, { displayName: ' Nama Baru ' });
    expect(profile.displayName).toBe('Nama Baru');
    expect(client.updateCalls).toEqual([
      { values: { display_name: 'Nama Baru' }, eq: { id: USER } },
    ]);
  });

  it('mengirim keduanya bila keduanya diisi', async () => {
    const { client, service } = setup();
    await service.updateProfile(USER, { displayName: 'B', avatarColor: '#abcdef' });
    expect(client.updateCalls[0]?.values).toEqual({
      display_name: 'B',
      avatar_color: '#abcdef',
    });
  });

  it('patch kosong / tidak valid ditolak sebelum kueri', async () => {
    const { client, service } = setup();
    await expect(service.updateProfile(USER, {})).rejects.toMatchObject({
      code: 'update-empty',
    });
    await expect(
      service.updateProfile(USER, { displayName: 'x'.repeat(40) }),
    ).rejects.toMatchObject({ code: 'update-empty' });
    await expect(service.updateProfile(USER, { avatarColor: 'pink' })).rejects.toMatchObject({
      code: 'update-empty',
    });
    expect(client.updateCalls).toHaveLength(0);
  });

  it('error update dari server dibungkus profile-error', async () => {
    const client = new FakeProfileClient({
      rows: [row()],
      failUpdateWith: { message: 'RLS violation' },
    });
    const service = new ProfileService({ supabase: client });
    await expect(service.updateProfile(USER, { displayName: 'B' })).rejects.toMatchObject({
      code: 'profile-error',
      message: expect.stringContaining('RLS violation'),
    });
  });

  it('baris hasil update tervalidasi ulang sebelum dikembalikan', async () => {
    const { service } = setup([row({ avatar_color: 'bukan-warna' })]);
    await expect(service.updateProfile(USER, { displayName: 'B' })).rejects.toMatchObject({
      code: 'invalid-profile-row',
    });
  });
});

describe('ProfileService.setVoiceSnippetPath', () => {
  it('menyimpan path valid dan mengembalikan profil baru', async () => {
    const { client, service } = setup();
    const path = `${USER}/snippet-abc.webm`;
    const profile = await service.setVoiceSnippetPath(USER, path);
    expect(profile.voiceSnippetPath).toBe(path);
    expect(client.updateCalls).toEqual([
      { values: { voice_snippet_path: path }, eq: { id: USER } },
    ]);
  });

  it('null menghapus penunjuk', async () => {
    const { client, service } = setup([row({ voice_snippet_path: `${USER}/a.webm` })]);
    const profile = await service.setVoiceSnippetPath(USER, null);
    expect(profile.voiceSnippetPath).toBeNull();
    expect(client.updateCalls[0]?.values).toEqual({ voice_snippet_path: null });
  });

  it('path asing ditolak sebelum kueri', async () => {
    const { client, service } = setup();
    await expect(service.setVoiceSnippetPath(USER, 'x.exe')).rejects.toMatchObject({
      code: 'invalid-path',
    });
    await expect(service.setVoiceSnippetPath(USER, 'a/b/c.webm')).rejects.toMatchObject({
      code: 'invalid-path',
    });
    expect(client.updateCalls).toHaveLength(0);
  });
});
