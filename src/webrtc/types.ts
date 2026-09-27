import { z } from 'zod';
import type { RealtimeChannel } from '@supabase/supabase-js';

// ============================================================
// Konstanta protokol mesh
// ============================================================

/** Versi protokol signaling — naikkan saat ada perubahan bentuk pesan. */
export const PROTOCOL_VERSION = 1 as const;

/** Maksimum total peserta per room (termasuk diri sendiri). */
export const MAX_ROOM_SIZE = 8;

/** Maksimum remote peer yang dikelola satu klien (diri sendiri dikecualikan). */
export const MAX_REMOTE_PEERS = MAX_ROOM_SIZE - 1;

/** Interval minimum antar pengiriman posisi per peer (~15 kali/detik). */
export const POSITION_SEND_INTERVAL_MS = 66;

/** Backpressure: posisi tidak dikirim bila buffer DataChannel melebihi ini. */
export const POSITION_MAX_BUFFERED_AMOUNT = 64 * 1024;

/** Batas absolut koordinat dunia (ruang virtual persegi, dua dimensi). */
export const WORLD_BOUND = 10_000;

/** Nama event broadcast Supabase Realtime untuk signaling WebRTC. */
export const SIGNAL_EVENT = 'signal';

/** Label DataChannel khusus sinkronisasi posisi. */
export const DATA_CHANNEL_LABEL = 'position';

// ============================================================
// Skema validasi (Zod) — semua payload lintas jaringan divalidasi
// ============================================================

export const RoomCodeSchema = z.string().regex(/^[a-z0-9]{4,12}$/);

export const SessionIdSchema = z.string().min(8).max(64);

export const AvatarColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** Metadata sesi yang dibawa presence Supabase (publik, tanpa rahasia). */
export const SessionInfoSchema = z.object({
  sessionId: SessionIdSchema,
  userId: z.string().min(1),
  displayName: z.string().min(1).max(32),
  avatarColor: AvatarColorSchema,
});

/** Posisi 2D di ruang virtual. */
export const PositionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

const SdpSchema = z.string().min(1);

/**
 * Pesan signaling WebRTC yang lewat broadcast Supabase Realtime.
 * `to` berisi sessionId target; bye memakai '*' (untuk semua peer).
 */
export const SignalMessageSchema = z.discriminatedUnion('type', [
  z.object({
    v: z.literal(PROTOCOL_VERSION),
    type: z.literal('offer'),
    from: SessionIdSchema,
    to: SessionIdSchema,
    sdp: SdpSchema,
  }),
  z.object({
    v: z.literal(PROTOCOL_VERSION),
    type: z.literal('answer'),
    from: SessionIdSchema,
    to: SessionIdSchema,
    sdp: SdpSchema,
  }),
  z.object({
    v: z.literal(PROTOCOL_VERSION),
    type: z.literal('ice'),
    from: SessionIdSchema,
    to: SessionIdSchema,
    candidate: z.string().nullable(),
    sdpMid: z.string().nullable(),
    sdpMLineIndex: z.number().int().nullable(),
    usernameFragment: z.string().nullable().optional(),
  }),
  z.object({
    v: z.literal(PROTOCOL_VERSION),
    type: z.literal('bye'),
    from: SessionIdSchema,
    to: z.literal('*'),
  }),
]);

// ============================================================
// Tipe turunan
// ============================================================

export type SessionInfo = z.infer<typeof SessionInfoSchema>;
export type Position = z.infer<typeof PositionSchema>;
export type SignalMessage = z.infer<typeof SignalMessageSchema>;
export type IceSignalMessage = Extract<SignalMessage, { type: 'ice' }>;

/** Snapshot kondisi sebuah remote peer (untuk UI/harness/metrics). */
export interface PeerState {
  sessionId: string;
  session: SessionInfo;
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  lastPosition: Position | null;
  lastPositionAt: number | null;
}

/** Peta event yang dipancarkan MeshRoomController. */
export interface MeshRoomEventMap {
  'peer-joined': { peer: PeerState };
  'peer-left': { sessionId: string };
  'peer-state': { peer: PeerState };
  'remote-stream': { sessionId: string; track: MediaStreamTrack; stream: MediaStream | null };
  'remote-position': { sessionId: string; position: Position; receivedAt: number };
  'invalid-signal': { reason: string };
  'invalid-position': { sessionId: string; reason: string };
  'room-full': { size: number; max: number };
  error: { message: string; cause?: unknown };
}

/**
 * Sub-kemampuan SupabaseClient yang dibutuhkan mesh room — structural typing
 * supaya SupabaseClient asli lolos tanpa adaptasi, dan test bisa menyuntik fake.
 */
export interface SupabaseRealtimeLike {
  channel(
    topic: string,
    options?: { config?: { presence?: { key?: string; enabled?: boolean } } },
  ): RealtimeChannel;
  removeChannel?(channel: RealtimeChannel): Promise<unknown>;
}

/** Membulatkan + mengunci posisi ke batas dunia (menghemat ukuran payload). */
export function clampPosition(position: Position): Position {
  const clamp = (n: number): number =>
    Math.round(Math.max(-WORLD_BOUND, Math.min(WORLD_BOUND, n)) * 100) / 100;
  return { x: clamp(position.x), y: clamp(position.y) };
}
