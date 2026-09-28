import { describe, expect, it } from 'vitest';
import {
  ALLOWED_CUSTOM_SOUND_MIMES,
  CUSTOM_SOUND_EXTENSION_BY_MIME,
  CustomSoundPathSchema,
  MAX_CUSTOM_SOUND_BYTES,
  PresetSoundAssetPathSchema,
  PresetSoundIdSchema,
  PresetSoundSchema,
  SIGNED_URL_DEFAULT_EXPIRY_S,
  SOUNDBOARD_BUCKET_NAME,
  SoundboardError,
  assertCustomSoundPath,
  isAllowedCustomSoundMime,
  makeCustomSoundPath,
} from './types';

const UUID = '7db26a0a-9ce5-4558-bd08-9612e9e9febe';

describe('konstanta selaras migrasi 0012', () => {
  it('nama bucket, cap byte, dan expiry default persis kontrak DB', () => {
    expect(SOUNDBOARD_BUCKET_NAME).toBe('soundboard-sounds');
    expect(MAX_CUSTOM_SOUND_BYTES).toBe(5_242_880);
    expect(SIGNED_URL_DEFAULT_EXPIRY_S).toBe(300);
  });

  it('ALLOWED_CUSTOM_SOUND_MIMES persis allowed_mime_types migrasi 0012', () => {
    expect(ALLOWED_CUSTOM_SOUND_MIMES).toEqual([
      'audio/webm',
      'audio/mpeg',
      'audio/wav',
      'audio/ogg',
      'audio/mp4',
    ]);
  });
});

describe('CustomSoundPathSchema', () => {
  it('menerima {userId}/{soundId}.{ext} untuk semua ekstensi', () => {
    expect(CustomSoundPathSchema.safeParse(`${UUID}/sound-abc123.webm`).success).toBe(true);
    expect(CustomSoundPathSchema.safeParse(`${UUID}/sound-abc123.mp3`).success).toBe(true);
    expect(CustomSoundPathSchema.safeParse(`${UUID}/sound-abc123.wav`).success).toBe(true);
    expect(CustomSoundPathSchema.safeParse(`${UUID}/sound-abc123.ogg`).success).toBe(true);
    expect(CustomSoundPathSchema.safeParse(`${UUID}/sound-abc123.m4a`).success).toBe(true);
    expect(CustomSoundPathSchema.safeParse('abc/sound-x.mp3').success).toBe(true);
    // userId bentuk UUID huruf besar tetap sah (folder = auth.uid()::text).
    expect(CustomSoundPathSchema.safeParse('ABC-123/sound-y.webm').success).toBe(true);
  });

  it('menolak traversal, dua level folder, ekstensi asing, dan bentuk tak utuh', () => {
    expect(CustomSoundPathSchema.safeParse('../evil/x.exe').success).toBe(false);
    expect(CustomSoundPathSchema.safeParse('a/b/c.mp3').success).toBe(false);
    expect(CustomSoundPathSchema.safeParse('a/sound.flac').success).toBe(false);
    expect(CustomSoundPathSchema.safeParse('a/sound.webm/x').success).toBe(false);
    expect(CustomSoundPathSchema.safeParse('a.mp3').success).toBe(false);
    expect(CustomSoundPathSchema.safeParse('/sound.mp3').success).toBe(false);
    expect(CustomSoundPathSchema.safeParse('a/sound').success).toBe(false);
    expect(CustomSoundPathSchema.safeParse('a/sound.WEBM').success).toBe(false);
    expect(CustomSoundPathSchema.safeParse('a//sound.mp3').success).toBe(false);
  });
});

describe('PresetSoundSchema', () => {
  const validPreset = {
    id: 'sad-violin',
    name: 'Sad Violin',
    category: 'meme',
    assetPath: '/sounds/sad-violin.mp3',
  };

  it('menerima entri preset valid', () => {
    expect(PresetSoundSchema.safeParse(validPreset).success).toBe(true);
  });

  it('menolak id yang bukan slug kebab-case', () => {
    expect(PresetSoundSchema.safeParse({ ...validPreset, id: 'SadViolin' }).success).toBe(false);
    expect(PresetSoundSchema.safeParse({ ...validPreset, id: 'sad_violin' }).success).toBe(false);
    expect(PresetSoundSchema.safeParse({ ...validPreset, id: '-sad' }).success).toBe(false);
    expect(PresetSoundSchema.safeParse({ ...validPreset, id: 'sad-' }).success).toBe(false);
    expect(PresetSoundSchema.safeParse({ ...validPreset, id: '' }).success).toBe(false);
  });

  it('menolak nama kosong/terlalu panjang dan kategori asing', () => {
    expect(PresetSoundSchema.safeParse({ ...validPreset, name: '' }).success).toBe(false);
    expect(PresetSoundSchema.safeParse({ ...validPreset, name: 'x'.repeat(33) }).success).toBe(
      false,
    );
    expect(PresetSoundSchema.safeParse({ ...validPreset, category: 'ambient' }).success).toBe(
      false,
    );
  });

  it('menolak assetPath di luar /sounds/ atau ekstensi tak dikenal', () => {
    expect(PresetSoundSchema.safeParse({ ...validPreset, assetPath: 'sounds/a.mp3' }).success).toBe(
      false,
    );
    expect(PresetSoundSchema.safeParse({ ...validPreset, assetPath: '/audio/a.mp3' }).success).toBe(
      false,
    );
    expect(
      PresetSoundSchema.safeParse({ ...validPreset, assetPath: '/sounds/a.flac' }).success,
    ).toBe(false);
    expect(
      PresetSoundSchema.safeParse({ ...validPreset, assetPath: '/sounds/A_B.mp3' }).success,
    ).toBe(false);
  });

  it('PresetSoundIdSchema dan PresetSoundAssetPathSchema berdiri sendiri', () => {
    expect(PresetSoundIdSchema.safeParse('airhorn').success).toBe(true);
    expect(PresetSoundAssetPathSchema.safeParse('/sounds/airhorn.mp3').success).toBe(true);
  });
});

describe('peta MIME → ekstensi', () => {
  it('memetakan kelima MIME bucket ke ekstensi konvensi path', () => {
    expect(CUSTOM_SOUND_EXTENSION_BY_MIME['audio/webm']).toBe('webm');
    expect(CUSTOM_SOUND_EXTENSION_BY_MIME['audio/mpeg']).toBe('mp3');
    expect(CUSTOM_SOUND_EXTENSION_BY_MIME['audio/wav']).toBe('wav');
    expect(CUSTOM_SOUND_EXTENSION_BY_MIME['audio/ogg']).toBe('ogg');
    expect(CUSTOM_SOUND_EXTENSION_BY_MIME['audio/mp4']).toBe('m4a');
  });

  it('isAllowedCustomSoundMime menerima MIME persis dan menolak varian codecs', () => {
    for (const mime of ALLOWED_CUSTOM_SOUND_MIMES) {
      expect(isAllowedCustomSoundMime(mime)).toBe(true);
    }
    expect(isAllowedCustomSoundMime('audio/webm;codecs=opus')).toBe(false);
    expect(isAllowedCustomSoundMime('audio/mpeg;codecs=mp3')).toBe(false);
    expect(isAllowedCustomSoundMime('audio/flac')).toBe(false);
    expect(isAllowedCustomSoundMime('')).toBe(false);
  });
});

describe('makeCustomSoundPath', () => {
  it('menyusun path userId/soundId.ext yang valid untuk tiap ekstensi', () => {
    expect(makeCustomSoundPath(UUID, 'sound-abc123', 'webm')).toBe(`${UUID}/sound-abc123.webm`);
    expect(makeCustomSoundPath(UUID, 'sound-abc123', 'm4a')).toBe(`${UUID}/sound-abc123.m4a`);
    expect(
      CustomSoundPathSchema.safeParse(makeCustomSoundPath(UUID, 'sound-abc123', 'mp3')).success,
    ).toBe(true);
  });

  it('menolak segmen kosong atau mengandung garis miring', () => {
    expect(() => makeCustomSoundPath('', 'sound-a', 'mp3')).toThrow(SoundboardError);
    expect(() => makeCustomSoundPath('a/b', 'sound-a', 'mp3')).toThrow(SoundboardError);
    expect(() => makeCustomSoundPath(UUID, '', 'mp3')).toThrow(SoundboardError);
    expect(() => makeCustomSoundPath(UUID, 'a/b', 'mp3')).toThrow(SoundboardError);
  });
});

describe('assertCustomSoundPath', () => {
  it('mengembalikan path yang valid', () => {
    expect(assertCustomSoundPath(`${UUID}/sound-a.webm`)).toBe(`${UUID}/sound-a.webm`);
  });

  it('melempar SoundboardError untuk path asing', () => {
    expect(() => assertCustomSoundPath('nope')).toThrow(SoundboardError);
    expect(() => assertCustomSoundPath('a/b/c.mp3')).toThrow(/validasi/);
  });
});

describe('SoundboardError', () => {
  it('membawa kode, nama, dan cause', () => {
    const cause = { message: 'kartu jaringan lepas' };
    const error = new SoundboardError('storage-error', 'upload gagal', cause);
    expect(error.name).toBe('SoundboardError');
    expect(error.code).toBe('storage-error');
    expect(error.message).toBe('upload gagal');
    expect(error.cause).toBe(cause);
  });

  it('tanpa cause tetap berperilaku Error biasa', () => {
    const error = new SoundboardError('wrong-mime', 'mime asing');
    expect(error.cause).toBeUndefined();
    expect(error instanceof Error).toBe(true);
  });
});
