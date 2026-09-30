import { describe, expect, it } from 'vitest';
import { VoiceSnippetService } from './voice-snippet-service';
import { FakeStorageBucket, FakeStorageClient } from './test-utils';
import {
  MAX_VOICE_SNIPPET_FILES,
  MAX_VOICE_SNIPPET_TOTAL_BYTES,
  STORAGE_LIST_PAGE_SIZE,
} from './types';

const USER = '7db26a0a-9ce5-4558-bd08-9612e9e9febe';
const MIB = 1024 * 1024;

function webmBlob(bytes: number, type = 'audio/webm;codecs=opus'): Blob {
  return new Blob([new Uint8Array(bytes)], { type });
}

/** Menyemai n file kecil milik USER (utk penghitungan kuota). */
function seedFiles(bucket: FakeStorageBucket, count: number, bytesPerFile = 1024): void {
  for (let i = 0; i < count; i += 1) {
    bucket.objects.set(`${USER}/snippet-${String(i).padStart(4, '0')}.webm`, {
      size: bytesPerFile,
      contentType: 'audio/webm',
    });
  }
}

function setup(options: { bucket?: FakeStorageBucket } = {}) {
  const bucket = options.bucket ?? new FakeStorageBucket();
  const client = new FakeStorageClient(bucket);
  const service = new VoiceSnippetService({
    supabase: client,
    now: () => 1_758_000_000_000,
    randomId: () => 'abcd1234',
  });
  return { bucket, service };
}

describe('VoiceSnippetService', () => {
  it('upload menyusun path folder-per-user + contentType persis audio/webm', async () => {
    const { bucket, service } = setup();
    const result = await service.uploadSnippet(USER, webmBlob(128));
    const expectedId = `snippet-${(1_758_000_000_000).toString(36)}-abcd1234`;
    expect(result.path).toBe(`${USER}/${expectedId}.webm`);
    expect(result.fullPath).toBe(`voice-snippets/${USER}/${expectedId}.webm`);
    expect(result.bytes).toBe(128);
    expect(bucket.uploadCalls).toHaveLength(1);
    expect(bucket.uploadCalls[0]).toMatchObject({
      contentType: 'audio/webm',
      upsert: false,
      cacheControl: '3600',
      bytes: 128,
    });
  });

  it('upload menolak userId kosong, blob kosong, kebesaran, dan mime asing', async () => {
    const { service } = setup();
    await expect(service.uploadSnippet('', webmBlob(10))).rejects.toMatchObject({
      code: 'not-signed-in',
    });
    await expect(service.uploadSnippet(USER, webmBlob(0))).rejects.toMatchObject({
      code: 'empty-recording',
    });
    await expect(service.uploadSnippet(USER, webmBlob(26_214_401))).rejects.toMatchObject({
      code: 'too-large',
    });
    await expect(
      service.uploadSnippet(USER, new Blob([new Uint8Array(10)], { type: 'audio/mp4' })),
    ).rejects.toMatchObject({ code: 'wrong-mime' });
  });

  it('upload bermime persis audio/webm tetap diterima', async () => {
    const { service } = setup();
    await expect(service.uploadSnippet(USER, webmBlob(10, 'audio/webm'))).resolves.toMatchObject({
      bytes: 10,
    });
  });

  it('error upload dari server dibungkus storage-error', async () => {
    const { service } = setup({
      bucket: new FakeStorageBucket({ failUploadWith: { message: 'Payload too large' } }),
    });
    await expect(service.uploadSnippet(USER, webmBlob(10))).rejects.toMatchObject({
      code: 'storage-error',
      message: expect.stringContaining('Payload too large'),
    });
  });

  it('createPlaybackUrl memanggil signedUrl dengan expiry dan mengembalikan URL', async () => {
    const { bucket, service } = setup();
    bucket.objects.set(`${USER}/snippet-a.webm`, { size: 10, contentType: 'audio/webm' });
    const result = await service.createPlaybackUrl(`${USER}/snippet-a.webm`, 120);
    expect(result.expiresInS).toBe(120);
    expect(result.signedUrl).toContain(`${USER}/snippet-a.webm`);
    expect(bucket.signedUrlCalls).toEqual([{ path: `${USER}/snippet-a.webm`, expiresIn: 120 }]);
  });

  it('createPlaybackUrl memakai expiry default 300 dan menolak nilai liar', async () => {
    const { bucket, service } = setup();
    bucket.objects.set(`${USER}/snippet-a.webm`, { size: 10, contentType: 'audio/webm' });
    await service.createPlaybackUrl(`${USER}/snippet-a.webm`);
    expect(bucket.signedUrlCalls[0]?.expiresIn).toBe(300);
    await expect(service.createPlaybackUrl('bukan-path', 300)).rejects.toMatchObject({
      code: 'invalid-path',
    });
    await expect(service.createPlaybackUrl(`${USER}/snippet-a.webm`, -1)).rejects.toMatchObject({
      code: 'invalid-path',
    });
    await expect(service.createPlaybackUrl(`${USER}/snippet-a.webm`, 1.5)).rejects.toMatchObject({
      code: 'invalid-path',
    });
  });

  it('deleteSnippet menghapus path valid dan menolak path asing', async () => {
    const { bucket, service } = setup();
    const path = `${USER}/snippet-a.webm`;
    bucket.objects.set(path, { size: 10, contentType: 'audio/webm' });
    await service.deleteSnippet(path);
    expect(bucket.objects.has(path)).toBe(false);
    expect(bucket.removeCalls).toEqual([[path]]);
    await expect(service.deleteSnippet('../evil.webm')).rejects.toMatchObject({
      code: 'invalid-path',
    });
  });

  it('listSnippetNames mengembalikan nama di folder user', async () => {
    const { bucket, service } = setup();
    bucket.objects.set(`${USER}/snippet-a.webm`, { size: 1, contentType: 'audio/webm' });
    bucket.objects.set(`${USER}/snippet-b.webm`, { size: 1, contentType: 'audio/webm' });
    bucket.objects.set('user-lain/snippet-c.webm', { size: 1, contentType: 'audio/webm' });
    const names = await service.listSnippetNames(USER);
    expect(names).toEqual(expect.arrayContaining(['snippet-a.webm', 'snippet-b.webm']));
    expect(names).not.toContain('snippet-c.webm');
    await expect(service.listSnippetNames('')).rejects.toMatchObject({ code: 'not-signed-in' });
  });
});

describe('VoiceSnippetService — kuota per-user (audit 25 M1)', () => {
  it('di bawah kuota → upload lanjut (satu halaman list lalu upload)', async () => {
    const { bucket, service } = setup();
    seedFiles(bucket, MAX_VOICE_SNIPPET_FILES - 1);
    await expect(service.uploadSnippet(USER, webmBlob(128))).resolves.toMatchObject({
      bytes: 128,
    });
    expect(bucket.uploadCalls).toHaveLength(1);
    expect(bucket.listCalls).toEqual([
      { folder: `${USER}/`, options: { limit: STORAGE_LIST_PAGE_SIZE, offset: 0 } },
    ]);
  });

  it('list 2 halaman (folder > 100 objek) → tetap terhitung penuh lalu over-quota ditolak', async () => {
    const { bucket, service } = setup();
    // 130 file kecil → halaman 1 (100) + halaman 2 (30) → 130 ≥ 5 file.
    seedFiles(bucket, STORAGE_LIST_PAGE_SIZE + 30);
    await expect(service.uploadSnippet(USER, webmBlob(128))).rejects.toMatchObject({
      code: 'quota_exceeded',
      message: expect.stringContaining('maksimum 5 file'),
    });
    expect(bucket.uploadCalls).toHaveLength(0);
    expect(bucket.listCalls).toEqual([
      { folder: `${USER}/`, options: { limit: STORAGE_LIST_PAGE_SIZE, offset: 0 } },
      { folder: `${USER}/`, options: { limit: STORAGE_LIST_PAGE_SIZE, offset: 100 } },
    ]);
  });

  it('jumlah file tepat MAX_FILES → unggahan berikutnya ditolak quota_exceeded', async () => {
    const { bucket, service } = setup();
    seedFiles(bucket, MAX_VOICE_SNIPPET_FILES);
    await expect(service.uploadSnippet(USER, webmBlob(128))).rejects.toMatchObject({
      code: 'quota_exceeded',
    });
    expect(bucket.uploadCalls).toHaveLength(0);
  });

  it('total byte melebihi MAX_TOTAL_BYTES → ditolak quota_exceeded (pesan ramah)', async () => {
    const { bucket, service } = setup();
    // 4 × 24 MiB = 96 MiB terpakai; unggahan 5 MiB → 101 MiB > cap 100 MiB.
    seedFiles(bucket, 4, 24 * MIB);
    await expect(service.uploadSnippet(USER, webmBlob(5 * MIB))).rejects.toMatchObject({
      code: 'quota_exceeded',
      message: expect.stringContaining('hapus snippet lama'),
    });
    expect(bucket.uploadCalls).toHaveLength(0);
  });

  it('total byte TEPAT di batas → masih diizinkan (batas = tidak melebihi)', async () => {
    const { bucket, service } = setup();
    // 4 × 24 MiB = 100.663.296; unggahan 4 MiB = 104.857.600 = cap persis.
    seedFiles(bucket, 4, 24 * MIB);
    const exact = MAX_VOICE_SNIPPET_TOTAL_BYTES - 4 * 24 * MIB;
    await expect(service.uploadSnippet(USER, webmBlob(exact))).resolves.toMatchObject({
      bytes: exact,
    });
    expect(bucket.uploadCalls).toHaveLength(1);
  });

  it('error list saat penghitungan kuota → dibungkus storage-error, upload batal', async () => {
    const { service } = setup({
      bucket: new FakeStorageBucket({ failListWith: { message: 'list denied' } }),
    });
    await expect(service.uploadSnippet(USER, webmBlob(128))).rejects.toMatchObject({
      code: 'storage-error',
      message: expect.stringContaining('list denied'),
    });
  });
});
