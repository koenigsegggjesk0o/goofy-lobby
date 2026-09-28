import { describe, expect, it } from 'vitest';
import { PresetSoundSchema } from './types';
import { PRESET_SOUNDS, getPresetSound, isPresetSoundId, listPresetSounds } from './preset-sounds';

describe('katalog preset sound', () => {
  it('setiap entri lolos PresetSoundSchema', () => {
    for (const preset of PRESET_SOUNDS) {
      expect(PresetSoundSchema.safeParse(preset).success).toBe(true);
    }
  });

  it('id unik dalam katalog (id = kontrak stabil)', () => {
    const ids = PRESET_SOUNDS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Katalog inti Fase 2 — id ini TIDAK boleh berubah lintas rilis.
    expect(ids).toEqual([
      'airhorn',
      'bruh',
      'wow',
      'sad-violin',
      'crickets',
      'applause',
      'drumroll',
      'boing',
    ]);
  });

  it('assetPath selalu berformat /sounds/{nama}.{ext}', () => {
    for (const preset of PRESET_SOUNDS) {
      expect(preset.assetPath).toMatch(/^\/sounds\/[a-z0-9-]+\.(webm|mp3|wav|ogg|m4a)$/);
    }
  });

  it('setiap kategori terwakili (sfx dan meme)', () => {
    const categories = new Set(PRESET_SOUNDS.map((preset) => preset.category));
    expect(categories.has('sfx')).toBe(true);
    expect(categories.has('meme')).toBe(true);
  });
});

describe('listPresetSounds', () => {
  it('mengembalikan seluruh katalog', () => {
    expect(listPresetSounds()).toBe(PRESET_SOUNDS);
    expect(listPresetSounds()).toHaveLength(PRESET_SOUNDS.length);
  });
});

describe('getPresetSound', () => {
  it('menemukan preset berdasarkan id', () => {
    const preset = getPresetSound('sad-violin');
    expect(preset).not.toBeNull();
    expect(preset?.id).toBe('sad-violin');
    expect(preset?.assetPath).toBe('/sounds/sad-violin.mp3');
  });

  it('null untuk id asing atau kosong', () => {
    expect(getPresetSound('suara-asing')).toBeNull();
    expect(getPresetSound('')).toBeNull();
    expect(getPresetSound('AIRHORN')).toBeNull();
  });
});

describe('isPresetSoundId', () => {
  it('true untuk semua id katalog, false untuk lainnya', () => {
    for (const preset of PRESET_SOUNDS) {
      expect(isPresetSoundId(preset.id)).toBe(true);
    }
    expect(isPresetSoundId('bukan-preset')).toBe(false);
    expect(isPresetSoundId('')).toBe(false);
  });
});
