import { describe, expect, it } from 'vitest';
import {
  AvatarColorSchema,
  PositionSchema,
  RoomCodeSchema,
  SessionInfoSchema,
  SignalMessageSchema,
  clampPosition,
  WORLD_BOUND,
} from './types';

describe('RoomCodeSchema', () => {
  it('menerima kode [a-z0-9]{4,12}', () => {
    expect(RoomCodeSchema.safeParse('lobby01').success).toBe(true);
    expect(RoomCodeSchema.safeParse('abcd').success).toBe(true);
    expect(RoomCodeSchema.safeParse('a'.repeat(12)).success).toBe(true);
  });

  it('menolak kode di luar pola', () => {
    expect(RoomCodeSchema.safeParse('abc').success).toBe(false); // terlalu pendek
    expect(RoomCodeSchema.safeParse('a'.repeat(13)).success).toBe(false); // terlalu panjang
    expect(RoomCodeSchema.safeParse('LOBBY').success).toBe(false); // huruf besar
    expect(RoomCodeSchema.safeParse('lob by').success).toBe(false); // spasi
    expect(RoomCodeSchema.safeParse('lobby!').success).toBe(false); // simbol
  });
});

describe('PositionSchema', () => {
  it('menerima angka finite', () => {
    expect(PositionSchema.safeParse({ x: 0, y: -12.5 }).success).toBe(true);
    expect(PositionSchema.safeParse({ x: 1e9, y: 1e-9 }).success).toBe(true);
  });

  it('menolak nilai non-finite dan tipe salah', () => {
    expect(PositionSchema.safeParse({ x: Number.POSITIVE_INFINITY, y: 0 }).success).toBe(false);
    expect(PositionSchema.safeParse({ x: Number.NaN, y: 0 }).success).toBe(false);
    expect(PositionSchema.safeParse({ x: '1', y: 2 }).success).toBe(false);
    expect(PositionSchema.safeParse({ x: 1 }).success).toBe(false); // y hilang
  });
});

describe('SessionInfoSchema', () => {
  const valid = {
    sessionId: 'session-0001-xxxx',
    userId: 'user-1',
    displayName: 'Tester',
    avatarColor: '#22aa44',
  };

  it('menerima metadata sesi lengkap', () => {
    expect(SessionInfoSchema.safeParse(valid).success).toBe(true);
  });

  it('menolak field cacat', () => {
    expect(SessionInfoSchema.safeParse({ ...valid, sessionId: 'short' }).success).toBe(false);
    expect(SessionInfoSchema.safeParse({ ...valid, displayName: '' }).success).toBe(false);
    expect(SessionInfoSchema.safeParse({ ...valid, displayName: 'x'.repeat(33) }).success).toBe(
      false,
    );
    expect(SessionInfoSchema.safeParse({ ...valid, avatarColor: '22aa44' }).success).toBe(false); // tanpa #
    expect(SessionInfoSchema.safeParse({ ...valid, avatarColor: '#22AA4' }).success).toBe(false); // 5 hex
    expect(SessionInfoSchema.safeParse({ ...valid, userId: '' }).success).toBe(false);
  });
});

describe('SignalMessageSchema', () => {
  const from = 'session-0001-xxxx';
  const to = 'session-0002-xxxx';

  it('menerima offer/answer/ice/bye yang sah', () => {
    expect(
      SignalMessageSchema.safeParse({ v: 1, type: 'offer', from, to, sdp: 'v=0\r\n...' }).success,
    ).toBe(true);
    expect(
      SignalMessageSchema.safeParse({ v: 1, type: 'answer', from, to, sdp: 'v=0\r\n...' }).success,
    ).toBe(true);
    expect(
      SignalMessageSchema.safeParse({
        v: 1,
        type: 'ice',
        from,
        to,
        candidate: 'candidate:1 1 UDP 1 10.0.0.1 8998 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
        usernameFragment: 'abc',
      }).success,
    ).toBe(true);
    expect(
      SignalMessageSchema.safeParse({
        v: 1,
        type: 'ice',
        from,
        to,
        candidate: null,
        sdpMid: null,
        sdpMLineIndex: null,
      }).success,
    ).toBe(true);
    expect(SignalMessageSchema.safeParse({ v: 1, type: 'bye', from, to: '*' }).success).toBe(true);
  });

  it('menolak pesan berversi salah / field cacat', () => {
    expect(
      SignalMessageSchema.safeParse({ v: 999, type: 'offer', from, to, sdp: 'v=0' }).success,
    ).toBe(false);
    expect(SignalMessageSchema.safeParse({ v: 1, type: 'offer', from, to, sdp: '' }).success).toBe(
      false,
    );
    expect(SignalMessageSchema.safeParse({ v: 1, type: 'offer', from, to }).success).toBe(false);
    expect(
      SignalMessageSchema.safeParse({
        v: 1,
        type: 'ice',
        from,
        to,
        candidate: 'x',
        sdpMid: '0',
        sdpMLineIndex: 1.5,
      }).success,
    ).toBe(false);
    expect(SignalMessageSchema.safeParse({ v: 1, type: 'bye', from, to }).success).toBe(false); // to bukan '*'
    expect(SignalMessageSchema.safeParse({ v: 1, type: 'renegotiate', from, to }).success).toBe(
      false,
    );
  });
});

describe('AvatarColorSchema', () => {
  it('hanya menerima hex #rrggbb', () => {
    expect(AvatarColorSchema.safeParse('#abcdef').success).toBe(true);
    expect(AvatarColorSchema.safeParse('#ABCDEF').success).toBe(true);
    expect(AvatarColorSchema.safeParse('#abcde').success).toBe(false);
    expect(AvatarColorSchema.safeParse('abcdef').success).toBe(false);
  });
});

describe('clampPosition', () => {
  it('membatasi koordinat ke batas dunia', () => {
    expect(clampPosition({ x: WORLD_BOUND + 100, y: 0 })).toEqual({ x: WORLD_BOUND, y: 0 });
    expect(clampPosition({ x: -WORLD_BOUND * 5, y: 0 })).toEqual({ x: -WORLD_BOUND, y: 0 });
  });

  it('membulatkan ke 2 desimal (payload tetap kecil)', () => {
    expect(clampPosition({ x: -0.12345, y: 3.14159265 })).toEqual({ x: -0.12, y: 3.14 });
  });

  it('tidak mengubah nilai yang sudah rapi', () => {
    expect(clampPosition({ x: 10, y: -20 })).toEqual({ x: 10, y: -20 });
  });
});
