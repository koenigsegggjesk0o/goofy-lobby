import { describe, expect, it } from 'vitest';
import { CustomSoundService } from './custom-sound-service';
import { FakeStorageBucket, FakeStorageClient } from './test-utils';
import {
  MAX_CUSTOM_SOUND_BYTES,
  MAX_CUSTOM_SOUND_FILES,
  MAX_CUSTOM_SOUND_TOTAL_BYTES,
  STORAGE_LIST_PAGE_SIZE,
} from './types';

const USER = '7db26a0a-9ce5-4558-bd08-9612e9e9febe';
const NOW_MS = 1_758_000_000_000;
const MIB = 1024 * 1024;

function audioBlob(bytes: number, type = 'audio/webm'): Blob {
  return new Blob([new Uint8Array(bytes)], { type });
}

/** Menyemai n file kecil milik USER (utk penghitungan kuota). */
function seedFiles(bucket: FakeStorageBucket, count: number, bytesPerFile = 1024): void {
  for (let i = 0; i < count; i += 1) {
    bucket.objects.set(`${USER}/sound-${String(i).padStart(4, '0')}.mp3`, {
      size: bytesPerFile,
      contentType: 'audio/mpeg',
    });
  }
}

function setup(options: { bucket?: FakeStorageBucket } = {}) {
  const bucket = options.bucket ?? new FakeStorageBucket();
  const client = new FakeStorageClient(bucket);
  const service = new CustomSoundService({
    supabase: client,
    now: () => NOW_MS,
    randomId: () => 'abcd1234',
  });
  return { bucket, service };
}

describe('CustomSoundService.uploadCustomSound', () => {
  it('upload menyusun path folder-per-user + contentType persis + upsert false', async () => {
    const { bucket, service } = setup();
    const result = await service.uploadCustomSound(USER, audioBlob(256, 'audio/mpeg'));
    const expectedId = `sound-${NOW_MS.toString(36)}-abcd1234`;
    expect(result).toEqual({
      path: `${USER}/${expectedId}.mp3`,
      fullPath: `soundboard-sounds/${USER}/${expectedId}.mp3`,
      bytes: 256,
      mimeType: 'audio/mpeg',
    });
    expect(bucket.uploadCalls).toHaveLength(1);
    expect(bucket.uploadCalls[0]).toMatchObject({
      path: `${USER}/${expectedId}.mp3`,
      contentType: 'audio/mpeg',
      upsert: false,
      cacheControl: '3600',
      bytes: 256,
    });
  });

  it('menurunkan ekstensi dari MIME: webm, mp3 (audio/mpeg), wav, ogg, m4a (audio/mp4)', async () => {
    const { service } = setup();
    const cases: Array<{ mime: string; ext: string }> = [
      { mime: 'audio/webm', ext: 'webm' },
      { mime: 'audio/mpeg', ext: 'mp3' },
      { mime: 'audio/wav', ext: 'wav' },
      { mime: 'audio/ogg', ext: 'ogg' },
      { mime: 'audio/mp4', ext: 'm4a' },
    ];
    for (const { mime, ext } of cases) {
      const result = await service.uploadCustomSound(USER, audioBlob(10, mime));
      expect(result.path).toMatch(new RegExp(`^${USER}/sound-[a-z0-9]+-[a-z0-9]+\\.${ext}$`));
      expect(result.mimeType).toBe(mime);
    }
  });

  it('menolak userId kosong, blob kosong, kebesaran, dan mime asing SEBELUM jaringan', async () => {
    const { bucket, service } = setup();
    await expect(service.uploadCustomSound('', audioBlob(10))).rejects.toMatchObject({
      code: 'not-signed-in',
    });
    await expect(service.uploadCustomSound(USER, audioBlob(0))).rejects.toMatchObject({
      code: 'empty-file',
    });
    await expect(
      service.uploadCustomSound(USER, audioBlob(MAX_CUSTOM_SOUND_BYTES + 1)),
    ).rejects.toMatchObject({ code: 'too-large' });
    // Varian codecs DITOLAK — bucket 0012 hanya menerima MIME persis.
    await expect(
      service.uploadCustomSound(USER, audioBlob(10, 'audio/webm;codecs=opus')),
    ).rejects.toMatchObject({ code: 'wrong-mime' });
    await expect(
      service.uploadCustomSound(USER, audioBlob(10, 'audio/flac')),
    ).rejects.toMatchObject({ code: 'wrong-mime' });
    await expect(service.uploadCustomSound(USER, audioBlob(10, ''))).rejects.toMatchObject({
      code: 'wrong-mime',
    });
    // Semua penolakan di atas lokal: fake storage tak tersentuh.
    expect(bucket.uploadCalls).toHaveLength(0);
    expect(bucket.objects.size).toBe(0);
  });

  it('error upload dari server dibungkus storage-error + cause', async () => {
    const { service } = setup({
      bucket: new FakeStorageBucket({ failUploadWith: { message: 'MIME type not allowed' } }),
    });
    await expect(service.uploadCustomSound(USER, audioBlob(10))).rejects.toMatchObject({
      code: 'storage-error',
      message: expect.stringContaining('MIME type not allowed'),
      cause: { message: 'MIME type not allowed' },
    });
  });
});

describe('CustomSoundService.createPlaybackUrl', () => {
  it('memanggil signedUrl dengan expiry dan mengembalikan URL', async () => {
    const { bucket, service } = setup();
    bucket.objects.set(`${USER}/sound-a.mp3`, { size: 10, contentType: 'audio/mpeg' });
    const result = await service.createPlaybackUrl(`${USER}/sound-a.mp3`, 120);
    expect(result.expiresInS).toBe(120);
    expect(result.signedUrl).toContain(`${USER}/sound-a.mp3`);
    expect(bucket.signedUrlCalls).toEqual([{ path: `${USER}/sound-a.mp3`, expiresIn: 120 }]);
  });

  it('memakai expiry default 300 dan menolak path/expiresInS liar', async () => {
    const { bucket, service } = setup();
    bucket.objects.set(`${USER}/sound-a.webm`, { size: 10, contentType: 'audio/webm' });
    await service.createPlaybackUrl(`${USER}/sound-a.webm`);
    expect(bucket.signedUrlCalls[0]?.expiresIn).toBe(300);
    await expect(service.createPlaybackUrl('bukan-path', 300)).rejects.toMatchObject({
      code: 'invalid-path',
    });
    await expect(service.createPlaybackUrl(`${USER}/sound-a.webm`, -1)).rejects.toMatchObject({
      code: 'invalid-path',
    });
    await expect(service.createPlaybackUrl(`${USER}/sound-a.webm`, 0)).rejects.toMatchObject({
      code: 'invalid-path',
    });
    await expect(service.createPlaybackUrl(`${USER}/sound-a.webm`, 1.5)).rejects.toMatchObject({
      code: 'invalid-path',
    });
    await expect(service.createPlaybackUrl(`${USER}/sound-a.webm`, 86_401)).rejects.toMatchObject({
      code: 'invalid-path',
    });
  });

  it('error signedUrl dari server dibungkus storage-error', async () => {
    const { service } = setup({
      bucket: new FakeStorageBucket({ failSignedUrlWith: { message: 'signing failed' } }),
    });
    await expect(service.createPlaybackUrl(`${USER}/sound-a.mp3`)).rejects.toMatchObject({
      code: 'storage-error',
      message: expect.stringContaining('signing failed'),
    });
  });
});

describe('CustomSoundService.deleteCustomSound', () => {
  it('menghapus path valid dan menolak path asing', async () => {
    const { bucket, service } = setup();
    const path = `${USER}/sound-a.ogg`;
    bucket.objects.set(path, { size: 10, contentType: 'audio/ogg' });
    await service.deleteCustomSound(path);
    expect(bucket.objects.has(path)).toBe(false);
    expect(bucket.removeCalls).toEqual([[path]]);
    await expect(service.deleteCustomSound('../evil.mp3')).rejects.toMatchObject({
      code: 'invalid-path',
    });
    await expect(service.deleteCustomSound('sound-a.mp3')).rejects.toMatchObject({
      code: 'invalid-path',
    });
  });

  it('error remove dari server dibungkus storage-error', async () => {
    const { service } = setup({
      bucket: new FakeStorageBucket({ failRemoveWith: { message: 'delete denied' } }),
    });
    await expect(service.deleteCustomSound(`${USER}/sound-a.mp3`)).rejects.toMatchObject({
      code: 'storage-error',
      message: expect.stringContaining('delete denied'),
    });
  });
});

describe('CustomSoundService.listCustomSoundNames', () => {
  it('mengembalikan nama di folder user saja', async () => {
    const { bucket, service } = setup();
    bucket.objects.set(`${USER}/sound-a.mp3`, { size: 1, contentType: 'audio/mpeg' });
    bucket.objects.set(`${USER}/sound-b.m4a`, { size: 1, contentType: 'audio/mp4' });
    bucket.objects.set('user-lain/sound-c.webm', { size: 1, contentType: 'audio/webm' });
    const names = await service.listCustomSoundNames(USER);
    expect(names).toEqual(expect.arrayContaining(['sound-a.mp3', 'sound-b.m4a']));
    expect(names).not.toContain('sound-c.webm');
    await expect(service.listCustomSoundNames('')).rejects.toMatchObject({
      code: 'not-signed-in',
    });
  });

  it('error list dari server dibungkus storage-error', async () => {
    const { service } = setup({
      bucket: new FakeStorageBucket({ failListWith: { message: 'list denied' } }),
    });
    await expect(service.listCustomSoundNames(USER)).rejects.toMatchObject({
      code: 'storage-error',
      message: expect.stringContaining('list denied'),
    });
  });
});

describe('CustomSoundService — kuota per-user (audit 25 M1)', () => {
  it('di bawah kuota → upload lanjut (satu halaman list lalu upload)', async () => {
    const { bucket, service } = setup();
    seedFiles(bucket, MAX_CUSTOM_SOUND_FILES - 1);
    await expect(
      service.uploadCustomSound(USER, audioBlob(256, 'audio/mpeg')),
    ).resolves.toMatchObject({ bytes: 256 });
    expect(bucket.uploadCalls).toHaveLength(1);
    expect(bucket.listCalls).toEqual([
      { folder: `${USER}/`, options: { limit: STORAGE_LIST_PAGE_SIZE, offset: 0 } },
    ]);
  });

  it('list 2 halaman (folder > 100 objek) → tetap terhitung penuh lalu over-quota ditolak', async () => {
    const { bucket, service } = setup();
    // 130 file kecil → halaman 1 (100) + halaman 2 (30) → 130 ≥ 30 file.
    seedFiles(bucket, STORAGE_LIST_PAGE_SIZE + 30);
    await expect(service.uploadCustomSound(USER, audioBlob(256))).rejects.toMatchObject({
      code: 'quota_exceeded',
      message: expect.stringContaining(`maksimum ${MAX_CUSTOM_SOUND_FILES} file`),
    });
    expect(bucket.uploadCalls).toHaveLength(0);
    expect(bucket.listCalls).toEqual([
      { folder: `${USER}/`, options: { limit: STORAGE_LIST_PAGE_SIZE, offset: 0 } },
      { folder: `${USER}/`, options: { limit: STORAGE_LIST_PAGE_SIZE, offset: 100 } },
    ]);
  });

  it('jumlah file tepat MAX_FILES → unggahan berikutnya ditolak quota_exceeded', async () => {
    const { bucket, service } = setup();
    seedFiles(bucket, MAX_CUSTOM_SOUND_FILES);
    await expect(service.uploadCustomSound(USER, audioBlob(256))).rejects.toMatchObject({
      code: 'quota_exceeded',
    });
    expect(bucket.uploadCalls).toHaveLength(0);
  });

  it('total byte melebihi MAX_TOTAL_BYTES → ditolak quota_exceeded (pesan ramah)', async () => {
    const { bucket, service } = setup();
    // 3 × 60 MiB = 180 MiB terpakai > cap 150 MiB — unggahan apa pun ditolak.
    seedFiles(bucket, 3, 60 * MIB);
    await expect(service.uploadCustomSound(USER, audioBlob(1024))).rejects.toMatchObject({
      code: 'quota_exceeded',
      message: expect.stringContaining('hapus sound lama'),
    });
    expect(bucket.uploadCalls).toHaveLength(0);
  });

  it('total byte TEPAT di batas → masih diizinkan (batas = tidak melebihi)', async () => {
    const { bucket, service } = setup();
    // 29 file × 5 MiB = 145 MiB; unggahan 5 MiB → tepat 150 MiB = cap.
    seedFiles(bucket, MAX_CUSTOM_SOUND_FILES - 1, MAX_CUSTOM_SOUND_BYTES);
    const exact =
      MAX_CUSTOM_SOUND_TOTAL_BYTES - (MAX_CUSTOM_SOUND_FILES - 1) * MAX_CUSTOM_SOUND_BYTES;
    await expect(service.uploadCustomSound(USER, audioBlob(exact))).resolves.toMatchObject({
      bytes: exact,
    });
    expect(bucket.uploadCalls).toHaveLength(1);
  });

  it('error list saat penghitungan kuota → dibungkus storage-error, upload batal', async () => {
    const { service } = setup({
      bucket: new FakeStorageBucket({ failListWith: { message: 'list denied' } }),
    });
    await expect(service.uploadCustomSound(USER, audioBlob(256))).rejects.toMatchObject({
      code: 'storage-error',
      message: expect.stringContaining('list denied'),
    });
  });
});
