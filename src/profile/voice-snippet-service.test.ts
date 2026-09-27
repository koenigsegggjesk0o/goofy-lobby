import { describe, expect, it } from 'vitest';
import { VoiceSnippetService } from './voice-snippet-service';
import { FakeStorageBucket, FakeStorageClient } from './test-utils';

const USER = '7db26a0a-9ce5-4558-bd08-9612e9e9febe';

function webmBlob(bytes: number, type = 'audio/webm;codecs=opus'): Blob {
  return new Blob([new Uint8Array(bytes)], { type });
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
