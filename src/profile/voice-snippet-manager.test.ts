import { describe, expect, it, vi } from 'vitest';
import { VoiceSnippetManager } from './voice-snippet-manager';
import { ProfileService } from './profile-service';
import { VoiceSnippetService } from './voice-snippet-service';
import { FakeProfileClient, FakeStorageBucket, FakeStorageClient } from './test-utils';
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

function webmBlob(bytes: number): Blob {
  return new Blob([new Uint8Array(bytes)], { type: 'audio/webm' });
}

function setup(rows: ProfileRow[] = [row()]) {
  const bucket = new FakeStorageBucket();
  const profileClient = new FakeProfileClient({ rows });
  const snippets = new VoiceSnippetService({
    supabase: new FakeStorageClient(bucket),
    now: () => 1_000,
    randomId: () => 'aaaa1111',
  });
  const profiles = new ProfileService({ supabase: profileClient });
  const onError = vi.fn();
  const manager = new VoiceSnippetManager({ snippets, profiles, onError });
  return { bucket, profileClient, snippets, profiles, manager, onError };
}

describe('VoiceSnippetManager.replaceSnippet', () => {
  it('unggah → arahkan profil → hapus lama (urutan lengkap)', async () => {
    const oldPath = `${USER}/snippet-old.webm`;
    const { bucket, profileClient, manager } = setup([row({ voice_snippet_path: oldPath })]);
    bucket.objects.set(oldPath, { size: 10, contentType: 'audio/webm' });

    const result = await manager.replaceSnippet(USER, webmBlob(64));

    expect(result.previousPath).toBe(oldPath);
    expect(result.previousDeleted).toBe(true);
    expect(bucket.objects.has(oldPath)).toBe(false);
    expect(bucket.objects.has(result.path)).toBe(true);
    expect(profileClient.rows[0]?.voice_snippet_path).toBe(result.path);
    // Urutan: update profil terjadi SETELAH upload dan SEBELUM delete lama.
    expect(bucket.uploadCalls[0]?.path).toBe(result.path);
    expect(bucket.removeCalls).toEqual([[oldPath]]);
  });

  it('tanpa snippet sebelumnya → tidak ada penghapusan', async () => {
    const { bucket, manager } = setup();
    const result = await manager.replaceSnippet(USER, webmBlob(32));
    expect(result.previousPath).toBeNull();
    expect(result.previousDeleted).toBe(false);
    expect(bucket.removeCalls).toHaveLength(0);
  });

  it('gagal hapus snippet lama = non-fatal (dilaporkan, penggantian tetap sukses)', async () => {
    const oldPath = `${USER}/snippet-old.webm`;
    const bucket = new FakeStorageBucket({
      objects: new Map([[oldPath, { size: 10, contentType: 'audio/webm' }]]),
      failRemoveWith: { message: 'network hiccup' },
    });
    const profileClient = new FakeProfileClient({
      rows: [row({ voice_snippet_path: oldPath })],
    });
    const snippets = new VoiceSnippetService({
      supabase: new FakeStorageClient(bucket),
      now: () => 1_000,
      randomId: () => 'aaaa1111',
    });
    const profiles = new ProfileService({ supabase: profileClient });
    const onError = vi.fn();
    const manager = new VoiceSnippetManager({ snippets, profiles, onError });

    const result = await manager.replaceSnippet(USER, webmBlob(32));

    expect(result.previousDeleted).toBe(false);
    expect(profileClient.rows[0]?.voice_snippet_path).toBe(result.path);
    expect(onError).toHaveBeenCalledWith('delete-previous-snippet', expect.anything());
  });

  it('gagal update profil setelah upload → error diteruskan, profil tetap menunjuk lama', async () => {
    const oldPath = `${USER}/snippet-old.webm`;
    const bucket = new FakeStorageBucket({
      objects: new Map([[oldPath, { size: 10, contentType: 'audio/webm' }]]),
    });
    const profileClient = new FakeProfileClient({
      rows: [row({ voice_snippet_path: oldPath })],
      failUpdateWith: { message: 'row missing' },
    });
    const snippets = new VoiceSnippetService({
      supabase: new FakeStorageClient(bucket),
      now: () => 1_000,
      randomId: () => 'aaaa1111',
    });
    const profiles = new ProfileService({ supabase: profileClient });
    const manager = new VoiceSnippetManager({ snippets, profiles });

    await expect(manager.replaceSnippet(USER, webmBlob(32))).rejects.toMatchObject({
      code: 'profile-error',
    });
    // Objek baru jadi orphan (bukan profil menunjuk objek hilang) —
    // profil masih menunjuk path lama yang masih ada.
    expect(profileClient.rows[0]?.voice_snippet_path).toBe(oldPath);
    expect(bucket.objects.has(oldPath)).toBe(true);
    expect(bucket.removeCalls).toHaveLength(0);
  });

  it('blob tidak valid ditolak sebelum menyentuh storage maupun profil', async () => {
    const { bucket, profileClient, manager } = setup();
    await expect(
      manager.replaceSnippet(USER, new Blob([new Uint8Array(5)], { type: 'audio/mp4' })),
    ).rejects.toMatchObject({ code: 'wrong-mime' });
    expect(bucket.uploadCalls).toHaveLength(0);
    expect(profileClient.updateCalls).toHaveLength(0);
  });
});

describe('VoiceSnippetManager.clearSnippet', () => {
  it('null-kan penunjuk lalu hapus objek', async () => {
    const path = `${USER}/snippet-a.webm`;
    const { bucket, profileClient, manager } = setup([row({ voice_snippet_path: path })]);
    bucket.objects.set(path, { size: 10, contentType: 'audio/webm' });

    const result = await manager.clearSnippet(USER);

    expect(result.clearedPath).toBe(path);
    expect(profileClient.rows[0]?.voice_snippet_path).toBeNull();
    expect(bucket.objects.has(path)).toBe(false);
  });

  it('idempoten — tanpa snippet tidak melakukan apa pun', async () => {
    const { bucket, profileClient, manager } = setup();
    const result = await manager.clearSnippet(USER);
    expect(result.clearedPath).toBeNull();
    expect(profileClient.updateCalls).toHaveLength(0);
    expect(bucket.removeCalls).toHaveLength(0);
  });

  it('gagal hapus objek = non-fatal (penunjuk sudah null)', async () => {
    const path = `${USER}/snippet-a.webm`;
    const bucket = new FakeStorageBucket({
      objects: new Map([[path, { size: 10, contentType: 'audio/webm' }]]),
      failRemoveWith: { message: 'boom' },
    });
    const profileClient = new FakeProfileClient({ rows: [row({ voice_snippet_path: path })] });
    const snippets = new VoiceSnippetService({
      supabase: new FakeStorageClient(bucket),
      now: () => 1_000,
      randomId: () => 'aaaa1111',
    });
    const profiles = new ProfileService({ supabase: profileClient });
    const onError = vi.fn();
    const manager = new VoiceSnippetManager({ snippets, profiles, onError });

    const result = await manager.clearSnippet(USER);

    expect(result.clearedPath).toBe(path);
    expect(profileClient.rows[0]?.voice_snippet_path).toBeNull();
    expect(onError).toHaveBeenCalledWith('delete-cleared-snippet', expect.anything());
  });
});
