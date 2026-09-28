import { z } from 'zod';
import { verifyPaddleSignature } from './paddle-signature';
import type { ApplyPremiumStatus, PaddleWebhookEventInput, PaddleWebhookOutcome } from './types';

// Tipe input/outcome webhook didefinisikan terpusat di ./types (lihat
// kontrak modul); diekspor ulang di sini supaya permukaan modul router
// lengkap sendiri (dipakai antara lain oleh Edge Function Deno).
export type { PaddleWebhookEventInput, PaddleWebhookOutcome } from './types';

// ============================================================
// Skema validasi event
// ============================================================

/**
 * Envelope SEMUA event Paddle: event_type berformat entity.action,
 * occurred_at ISO string, data payload. event_id opsional (ada pada
 * event nyata; tidak dipakai routing MVP). Zod 4 memperlakukan properti
 * z.unknown() sebagai kunci wajib — data yang absen = invalid-event.
 */
const PaddleEnvelopeSchema = z.object({
  event_id: z.string().min(1).optional(),
  event_type: z.string().min(1),
  occurred_at: z.string().min(1),
  data: z.unknown(),
});

/** Bentuk dasar data event yang dipetakan ke user (transaction/subscription). */
const EventDataSchema = z.object({
  custom_data: z.unknown().optional(),
});

/** custom_data yang membawa user_id kami — uuid kolom profiles.id. */
const CustomDataUserIdSchema = z.object({
  user_id: z.string().uuid(),
});

// ============================================================
// Router core
// ============================================================

/**
 * Memproses satu webhook Paddle dari mentah (header + raw body + secret)
 * sampai penerapan status premium.
 *
 * Alur: verifikasi signature DULU (body belum dipercaya sebelum lolos) →
 * JSON.parse → validasi envelope Zod → routing event:
 * - 'transaction.completed'   → applyPremiumStatus(userId, true)
 * - 'subscription.canceled'   → applyPremiumStatus(userId, false)
 * - event lain                → { ok:true, handled:false } — acknowledge,
 *   BUKAN error: idempoten & aman untuk event baru Paddle (menolaknya
 *   hanya memicu retry tanpa henti dari Paddle).
 *
 * Murni — tanpa import runtime Deno/Node apa pun (lolos vitest);
 * efek samping DB disuntik lewat applyPremiumStatus.
 */
export async function handlePaddleWebhook(
  input: PaddleWebhookEventInput & {
    applyPremiumStatus: ApplyPremiumStatus;
    now?: () => number;
    toleranceMs?: number;
  },
): Promise<PaddleWebhookOutcome> {
  // 1. Signature — kegagalan apa pun langsung kembali (401 di Edge).
  const signature = await verifyPaddleSignature({
    header: input.header,
    rawBody: input.rawBody,
    secret: input.secret,
    now: input.now,
    toleranceMs: input.toleranceMs,
  });
  if (!signature.ok) {
    return { ok: false, reason: signature.reason };
  }

  // 2. Body harus JSON — rawBody teks mentah persis dari jaringan.
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(input.rawBody);
  } catch (error) {
    return { ok: false, reason: 'invalid-json', detail: errorMessage(error) };
  }

  // 3. Envelope.
  const envelope = PaddleEnvelopeSchema.safeParse(parsedJson);
  if (!envelope.success) {
    return { ok: false, reason: 'invalid-event', detail: formatIssues(envelope.error.issues) };
  }

  // 4. Routing.
  const eventType = envelope.data.event_type;
  if (eventType !== 'transaction.completed' && eventType !== 'subscription.canceled') {
    return { ok: true, handled: false, eventType };
  }
  const mapping = extractUserId(envelope.data.data);
  if (!mapping.ok) {
    return { ok: false, reason: mapping.reason, detail: mapping.detail };
  }
  // Mapping premium (keputusan terdokumentasi): transaksi selesai =
  // premium AKTIF; langganan batal = premium MATI. Status transaksi lain
  // (pending/refunded/dsb.) tidak dipetakan — hanya dua event inilah
  // yang mengubah is_premium pada MVP.
  const isPremium = eventType === 'transaction.completed';
  try {
    await input.applyPremiumStatus(mapping.userId, isPremium);
  } catch (error) {
    return { ok: false, reason: 'apply-failed', detail: errorMessage(error) };
  }
  return { ok: true, handled: true, eventType, userId: mapping.userId };
}

// ============================================================
// Internal
// ============================================================

type UserIdMapping =
  | { ok: true; userId: string }
  | { ok: false; reason: 'invalid-event' | 'missing-user-id'; detail?: string };

/**
 * Menyari user_id dari data event. Keputusan mapping (kontrak):
 * - data bukan objek → 'invalid-event' (bentuk event rusak);
 * - custom_data absen/null, ATAU user_id absen/bukan uuid →
 *   'missing-user-id' (event sah tapi tak terpetakan ke user) —
 *   user_id TIDAK PERNAH diteruskan ke apply tanpa lolos validasi uuid.
 */
function extractUserId(data: unknown): UserIdMapping {
  const dataParsed = EventDataSchema.safeParse(data);
  if (!dataParsed.success) {
    return { ok: false, reason: 'invalid-event', detail: 'data event bukan objek' };
  }
  const userParsed = CustomDataUserIdSchema.safeParse(dataParsed.data.custom_data);
  if (!userParsed.success) {
    return {
      ok: false,
      reason: 'missing-user-id',
      detail: 'custom_data.user_id absen atau bukan uuid',
    };
  }
  return { ok: true, userId: userParsed.data.user_id };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatIssues(issues: Array<{ path: PropertyKey[]; message: string }>): string {
  return issues
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}
