import type { PresetSound } from './types';

// ============================================================
// Katalog preset sound (DATA MODEL ONLY)
// ============================================================
// CATATAN JUJUR: file audio fisik di `public/sounds/` BELUM ada —
// aset suara sungguhan memang dijadwalkan Fase 3 (user menyediakan
// asetnya). Modul ini mendefinisikan KONTRAK data: id yang stabil
// lintas rilis + validasi bentuk (PresetSoundSchema), bukan asetnya.
// `assetPath` adalah janji path tempat aset akan diletakkan; selama
// file belum ada, pemutaran preset cukup ditangani caller sebagai
// "aset belum tersedia" — TIDAK ADA file audio placeholder dibuat di sini.

/**
 * Katalog preset sound bawaan. Id bersifat STABIL (bagian dari kontrak
 * publik — jangan pernah mengubah id yang sudah dirilis; tambah entri
 * baru di ekor bila perlu). Nama tampilan bebas berubah antar rilis.
 */
export const PRESET_SOUNDS: readonly PresetSound[] = Object.freeze([
  {
    id: 'airhorn',
    name: 'Airhorn',
    category: 'sfx',
    assetPath: '/sounds/airhorn.mp3',
  },
  {
    id: 'bruh',
    name: 'Bruh',
    category: 'meme',
    assetPath: '/sounds/bruh.mp3',
  },
  {
    id: 'wow',
    name: 'Wow',
    category: 'meme',
    assetPath: '/sounds/wow.mp3',
  },
  {
    id: 'sad-violin',
    name: 'Sad Violin',
    category: 'meme',
    assetPath: '/sounds/sad-violin.mp3',
  },
  {
    id: 'crickets',
    name: 'Crickets',
    category: 'meme',
    assetPath: '/sounds/crickets.mp3',
  },
  {
    id: 'applause',
    name: 'Applause',
    category: 'sfx',
    assetPath: '/sounds/applause.mp3',
  },
  {
    id: 'drumroll',
    name: 'Drumroll',
    category: 'sfx',
    assetPath: '/sounds/drumroll.mp3',
  },
  {
    id: 'boing',
    name: 'Boing',
    category: 'sfx',
    assetPath: '/sounds/boing.mp3',
  },
]);

/** Daftar seluruh preset sound (katalog dibekukan — hanya dibaca). */
export function listPresetSounds(): readonly PresetSound[] {
  return PRESET_SOUNDS;
}

/** Cari preset berdasarkan id — null bila id tidak ada di katalog. */
export function getPresetSound(id: string): PresetSound | null {
  return PRESET_SOUNDS.find((preset) => preset.id === id) ?? null;
}

/** Apakah `id` merujuk preset yang dikenal? (pemakaian: filter input user) */
export function isPresetSoundId(id: string): boolean {
  return getPresetSound(id) !== null;
}
