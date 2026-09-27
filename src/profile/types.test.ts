import { describe, expect, it } from 'vitest';
import {
  AvatarColorSchema,
  DisplayNameSchema,
  ProfileRowSchema,
  ProfileUpdateSchema,
  SnippetPathSchema,
  VoiceSnippetError,
  assertSnippetPath,
  makeSnippetPath,
} from './types';

const UUID = '7db26a0a-9ce5-4558-bd08-9612e9e9febe';

describe('DisplayNameSchema', () => {
  it('menerima 1–32 karakter dan memangkas spasi', () => {
    expect(DisplayNameSchema.safeParse('a').success).toBe(true);
    expect(DisplayNameSchema.safeParse('x'.repeat(32)).success).toBe(true);
    expect(DisplayNameSchema.safeParse('  nama ku  ').data).toBe('nama ku');
  });

  it('menolak kosong, lebih dari 32, dan non-string', () => {
    expect(DisplayNameSchema.safeParse('').success).toBe(false);
    expect(DisplayNameSchema.safeParse('   ').success).toBe(false);
    expect(DisplayNameSchema.safeParse('x'.repeat(33)).success).toBe(false);
    expect(DisplayNameSchema.safeParse(123).success).toBe(false);
  });
});

describe('AvatarColorSchema', () => {
  it('menerima #RRGGBB (huruf besar/kecil)', () => {
    expect(AvatarColorSchema.safeParse('#9ca3af').success).toBe(true);
    expect(AvatarColorSchema.safeParse('#ABCDEF').success).toBe(true);
  });

  it('menolak format lain', () => {
    expect(AvatarColorSchema.safeParse('9ca3af').success).toBe(false);
    expect(AvatarColorSchema.safeParse('#9ca3a').success).toBe(false);
    expect(AvatarColorSchema.safeParse('#9ca3af0').success).toBe(false);
    expect(AvatarColorSchema.safeParse('#gggggg').success).toBe(false);
  });
});

describe('SnippetPathSchema', () => {
  it('menerima {userId}/{snippetId}.webm', () => {
    expect(SnippetPathSchema.safeParse(`${UUID}/snippet-abc123.webm`).success).toBe(true);
    expect(SnippetPathSchema.safeParse(`abc/snippet-x.webm`).success).toBe(true);
  });

  it('menolak traversal, dua level folder, dan non-webm', () => {
    expect(SnippetPathSchema.safeParse('../evil/x.exe').success).toBe(false);
    expect(SnippetPathSchema.safeParse('a/b/c.webm').success).toBe(false);
    expect(SnippetPathSchema.safeParse('a/b.webm/x').success).toBe(false);
    expect(SnippetPathSchema.safeParse('a/snippet.mp3').success).toBe(false);
    expect(SnippetPathSchema.safeParse('a.webm').success).toBe(false);
    expect(SnippetPathSchema.safeParse('/snippet.webm').success).toBe(false);
  });
});

describe('ProfileUpdateSchema', () => {
  it('menerima satu field atau keduanya', () => {
    expect(ProfileUpdateSchema.safeParse({ displayName: 'Aulia' }).success).toBe(true);
    expect(ProfileUpdateSchema.safeParse({ avatarColor: '#aabbcc' }).success).toBe(true);
    expect(
      ProfileUpdateSchema.safeParse({ displayName: 'Aulia', avatarColor: '#aabbcc' }).success,
    ).toBe(true);
  });

  it('menolak patch kosong dan nilai tidak valid', () => {
    expect(ProfileUpdateSchema.safeParse({}).success).toBe(false);
    expect(ProfileUpdateSchema.safeParse({ displayName: '' }).success).toBe(false);
    expect(ProfileUpdateSchema.safeParse({ avatarColor: 'merah' }).success).toBe(false);
  });
});

describe('ProfileRowSchema', () => {
  const validRow = {
    id: UUID,
    display_name: 'QA Alpha',
    avatar_color: '#9ca3af',
    voice_snippet_path: null,
    created_at: '2026-09-27T10:00:00Z',
    updated_at: '2026-09-27T10:00:00Z',
  };

  it('menerima baris valid dengan voice_snippet_path null', () => {
    expect(ProfileRowSchema.safeParse(validRow).success).toBe(true);
  });

  it('menerima baris dengan voice_snippet_path terisi', () => {
    expect(
      ProfileRowSchema.safeParse({
        ...validRow,
        voice_snippet_path: `${UUID}/snippet-abc.webm`,
      }).success,
    ).toBe(true);
  });

  it('menolak baris dengan kolom hilang atau path asing', () => {
    expect(ProfileRowSchema.safeParse({ ...validRow, display_name: undefined }).success).toBe(
      false,
    );
    expect(
      ProfileRowSchema.safeParse({ ...validRow, voice_snippet_path: '../x.exe' }).success,
    ).toBe(false);
    expect(ProfileRowSchema.safeParse({ ...validRow, display_name: 'x'.repeat(33) }).success).toBe(
      false,
    );
  });
});

describe('makeSnippetPath', () => {
  it('menyusun path userId/snippetId.webm yang valid', () => {
    expect(makeSnippetPath(UUID, 'snippet-abc123')).toBe(`${UUID}/snippet-abc123.webm`);
    expect(SnippetPathSchema.safeParse(makeSnippetPath(UUID, 'snippet-abc123')).success).toBe(true);
  });

  it('menolak segmen kosong atau mengandung garis miring', () => {
    expect(() => makeSnippetPath('', 'snippet-a')).toThrow(VoiceSnippetError);
    expect(() => makeSnippetPath('a/b', 'snippet-a')).toThrow(VoiceSnippetError);
    expect(() => makeSnippetPath(UUID, '')).toThrow(VoiceSnippetError);
    expect(() => makeSnippetPath(UUID, 'a/b')).toThrow(VoiceSnippetError);
  });
});

describe('assertSnippetPath', () => {
  it('mengembalikan path yang valid', () => {
    expect(assertSnippetPath(`${UUID}/snippet-a.webm`)).toBe(`${UUID}/snippet-a.webm`);
  });

  it('melempar VoiceSnippetError untuk path asing', () => {
    expect(() => assertSnippetPath('nope')).toThrow(VoiceSnippetError);
    expect(() => assertSnippetPath('a/b/c.webm')).toThrow(/validasi/);
  });
});
