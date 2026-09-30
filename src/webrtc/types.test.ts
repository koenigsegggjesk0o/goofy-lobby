import { describe, expect, it } from 'vitest';
import {
  AvatarColorSchema,
  ICE_CANDIDATE_MAX_LENGTH,
  ICE_FIELD_MAX_LENGTH,
  PositionSchema,
  RoomCodeSchema,
  SDP_MAX_LENGTH,
  SessionInfoSchema,
  SignalMessageSchema,
  WORLD_COORD_MAX,
  clampPosition,
  normalizeRoomCode,
  WORLD_BOUND,
} from './types';

describe('RoomCodeSchema', () => {
  it('menerima kode Crockford-32 8 karakter (tanpa I/L/O/U)', () => {
    expect(RoomCodeSchema.safeParse('7Q2M9XK4').success).toBe(true);
    expect(RoomCodeSchema.safeParse('0123ABCD').success).toBe(true);
    expect(RoomCodeSchema.safeParse('ZW9YH7T2').success).toBe(true);
  });

  it('menolak kode di luar pola', () => {
    expect(RoomCodeSchema.safeParse('7Q2M9XK').success).toBe(false); // 7 char
    expect(RoomCodeSchema.safeParse('7Q2M9XK45').success).toBe(false); // 9 char
    expect(RoomCodeSchema.safeParse('7q2m9xk4').success).toBe(false); // huruf kecil
    expect(RoomCodeSchema.safeParse('7Q2M9XKI').success).toBe(false); // I
    expect(RoomCodeSchema.safeParse('7Q2M9XKL').success).toBe(false); // L
    expect(RoomCodeSchema.safeParse('7Q2M9XKO').success).toBe(false); // O
    expect(RoomCodeSchema.safeParse('7Q2M9XKU').success).toBe(false); // U
    expect(RoomCodeSchema.safeParse('7Q2-9XK4').success).toBe(false); // pemisah
    expect(RoomCodeSchema.safeParse('').success).toBe(false);
  });
});

describe('normalizeRoomCode', () => {
  it('uppercase + buang non-alfanumerik + O/I/L → 0/1/1 (paritas SQL 0016)', () => {
    expect(normalizeRoomCode('7q2m 9xk4')).toBe('7Q2M9XK4');
    expect(normalizeRoomCode(' 7q2m-9xk4 ')).toBe('7Q2M9XK4');
    expect(normalizeRoomCode('7Q2O9XKI')).toBe('7Q209XK1'); // O→0, I→1
    expect(normalizeRoomCode('7q2l9xki')).toBe('7Q219XK1'); // l→1, i→1
    expect(normalizeRoomCode('7Q2M9XK4')).toBe('7Q2M9XK4'); // idempoten
  });

  it('menghasilkan kode valid dari input user yang ramah salah ketik', () => {
    expect(RoomCodeSchema.safeParse(normalizeRoomCode('7q2o-9xki')).success).toBe(true);
    expect(normalizeRoomCode('7q2o-9xki')).toBe('7Q209XK1');
  });

  it('input sampah tetap sampah (bukan validasi, hanya normalisasi)', () => {
    expect(normalizeRoomCode('')).toBe('');
    expect(normalizeRoomCode('!!!')).toBe('');
    expect(RoomCodeSchema.safeParse(normalizeRoomCode('pendek')).success).toBe(false);
  });
});

describe('PositionSchema', () => {
  it('menerima angka finite di dalam batas dunia', () => {
    expect(PositionSchema.safeParse({ x: 0, y: -12.5 }).success).toBe(true);
    expect(PositionSchema.safeParse({ x: WORLD_COORD_MAX, y: 1e-9 }).success).toBe(true);
    expect(PositionSchema.safeParse({ x: -WORLD_COORD_MAX, y: -WORLD_COORD_MAX }).success).toBe(
      true,
    );
  });

  it('menolak nilai non-finite dan tipe salah', () => {
    expect(PositionSchema.safeParse({ x: Number.POSITIVE_INFINITY, y: 0 }).success).toBe(false);
    expect(PositionSchema.safeParse({ x: Number.NaN, y: 0 }).success).toBe(false);
    expect(PositionSchema.safeParse({ x: '1', y: 2 }).success).toBe(false);
    expect(PositionSchema.safeParse({ x: 1 }).success).toBe(false); // y hilang
  });

  // Remediasi audit 25-c (LOW): render path dulunya unbounded — finite saja
  // cukup; kini koordinat di luar |x|,|y| ≤ WORLD_COORD_MAX DITOLAK di skema.
  it('remediasi 25-c: menolak koordinat di luar WORLD_COORD_MAX (jalur render kini terbatas)', () => {
    expect(PositionSchema.safeParse({ x: WORLD_COORD_MAX + 1, y: 0 }).success).toBe(false);
    expect(PositionSchema.safeParse({ x: 0, y: -WORLD_COORD_MAX - 1 }).success).toBe(false);
    expect(PositionSchema.safeParse({ x: 1e9, y: 0 }).success).toBe(false);
    expect(PositionSchema.safeParse({ x: 1e300, y: 0 }).success).toBe(false);
    // Pesan penolakan menyebut batasnya (diagnostik jelas).
    const parsed = PositionSchema.safeParse({ x: WORLD_COORD_MAX + 1, y: 0 });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some(
          (issue) =>
            issue.message.includes('WORLD_COORD_MAX') ||
            issue.message.includes('100000') ||
            issue.message.includes('batas dunia'),
        ),
      ).toBe(true);
    }
  });

  it('WORLD_COORD_MAX lebih longgar daripada WORLD_BOUND jalur lokal/audio (clamp tetap ketat)', () => {
    // Koordinat antara WORLD_BOUND dan WORLD_COORD_MAX: sah di skema inbound
    // (di-clamp oleh jalur audio), tapi clampPosition tetap menahannya ke
    // WORLD_BOUND untuk jalur lokal — dua lapis pertahanan yang tidak bentrok.
    expect(WORLD_COORD_MAX).toBeGreaterThan(WORLD_BOUND);
    expect(PositionSchema.safeParse({ x: WORLD_BOUND + 1, y: 0 }).success).toBe(true);
    expect(clampPosition({ x: WORLD_BOUND + 1, y: 0 })).toEqual({ x: WORLD_BOUND, y: 0 });
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

  // ---- Remediasi audit 25-c (LOW): cap string inbound yang tak berbatas ----

  it('remediasi 25-c: menolak SDP lebih panjang dari SDP_MAX_LENGTH', () => {
    expect(
      SignalMessageSchema.safeParse({
        v: 1,
        type: 'offer',
        from,
        to,
        sdp: 'x'.repeat(SDP_MAX_LENGTH),
      }).success,
    ).toBe(true); // tepat di batas masih sah
    expect(
      SignalMessageSchema.safeParse({
        v: 1,
        type: 'offer',
        from,
        to,
        sdp: 'x'.repeat(SDP_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(
      SignalMessageSchema.safeParse({
        v: 1,
        type: 'answer',
        from,
        to,
        sdp: 'x'.repeat(SDP_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
    // Pesan penolakan menyebut angka batas (diagnostik jelas).
    const parsed = SignalMessageSchema.safeParse({
      v: 1,
      type: 'offer',
      from,
      to,
      sdp: 'x'.repeat(SDP_MAX_LENGTH + 1),
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((issue) => issue.message.includes(String(SDP_MAX_LENGTH))),
      ).toBe(true);
    }
  });

  it('remediasi 25-c: menolak field ICE (candidate/sdpMid/usernameFragment) raksasa', () => {
    const base = { v: 1 as const, type: 'ice' as const, from, to };
    // candidate melebihi batas → ditolak (null tetap sah — end-of-candidates).
    expect(
      SignalMessageSchema.safeParse({
        ...base,
        candidate: 'x'.repeat(ICE_CANDIDATE_MAX_LENGTH),
        sdpMid: '0',
        sdpMLineIndex: 0,
      }).success,
    ).toBe(true);
    expect(
      SignalMessageSchema.safeParse({
        ...base,
        candidate: 'x'.repeat(ICE_CANDIDATE_MAX_LENGTH + 1),
        sdpMid: '0',
        sdpMLineIndex: 0,
      }).success,
    ).toBe(false);
    // sdpMid raksasa → ditolak.
    expect(
      SignalMessageSchema.safeParse({
        ...base,
        candidate: 'candidate:1 1 UDP 1 10.0.0.1 8998 typ host',
        sdpMid: 'x'.repeat(ICE_FIELD_MAX_LENGTH + 1),
        sdpMLineIndex: 0,
      }).success,
    ).toBe(false);
    // usernameFragment raksasa → ditolak.
    expect(
      SignalMessageSchema.safeParse({
        ...base,
        candidate: 'candidate:1 1 UDP 1 10.0.0.1 8998 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
        usernameFragment: 'x'.repeat(ICE_FIELD_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
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
