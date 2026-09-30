import { z } from 'zod';
import { verifyPaddleSignature } from './paddle-signature';
import type {
  ApplyPremiumStatus,
  PaddleTransactionRow,
  PaddleWebhookDbLike,
  PaddleWebhookEventInput,
  PaddleWebhookOutcome,
} from './types';

// Tipe input/outcome webhook didefinisikan terpusat di ./types (lihat
// kontrak modul); diekspor ulang di sini supaya permukaan modul router
// lengkap sendiri (dipakai antara lain oleh Edge Function Deno).
export type { PaddleWebhookEventInput, PaddleWebhookOutcome } from './types';

// ============================================================
// Skema validasi event
// ============================================================

/**
 * Envelope SEMUA event Paddle: event_id, event_type berformat entity.action,
 * occurred_at ISO string, data payload. event_id kini WAJIB (remediasi
 * audit 25 B2 — idempotency): event nyata Paddle selalu membawanya, dan
 * dedup replay tidak bermakna tanpa identitas event. Zod 4 memperlakukan
 * properti z.unknown() sebagai kunci wajib — data yang absen = invalid-event.
 */
const PaddleEnvelopeSchema = z.object({
  event_id: z.string().min(1),
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

/**
 * Payload transaction.completed (remediasi audit 25 MEDIUM — verifikasi
 * harga): id = transaction id Paddle (field entity), items WAJIB ≥1 dan
 * item pertama membawa price.id yang dicocokkan terhadap allowlist;
 * amount_total/currency opsional (dicatat apa adanya ke ledger 0021).
 */
const TransactionCompletedDataSchema = EventDataSchema.extend({
  id: z.string().min(1),
  items: z.array(z.object({ price: z.object({ id: z.string().min(1) }) })).min(1),
  amount_total: z.number().optional(),
  currency: z.string().optional(),
});

/**
 * Payload adjustment.created/updated (remediasi audit 25 MEDIUM — refund):
 * action refund/credit berstatus approved = cabut premium user pemilik
 * transaksi; status lain (pending/rejected) dan action charge tidak
 * mengubah apa pun.
 */
const AdjustmentDataSchema = EventDataSchema.extend({
  action: z.enum(['refund', 'credit', 'charge']),
  status: z.enum(['approved', 'pending', 'rejected']),
  transaction_id: z.string().min(1),
});

// ============================================================
// Router core
// ============================================================

/** Dependensi router — efek samping (db ledger + apply) disuntik pemanggil. */
type RouterDeps = PaddleWebhookEventInput & {
  applyPremiumStatus: ApplyPremiumStatus;
  /** Klien db service_role untuk ledger 0021 (paddle_events/paddle_transactions). */
  db: PaddleWebhookDbLike;
  /** Allowlist price_id yang boleh memberi grant (fail-closed bila kosong). */
  allowedPriceIds?: readonly string[];
  now?: () => number;
  toleranceMs?: number;
};

/**
 * Memproses satu webhook Paddle dari mentah (header + raw body + secret)
 * sampai penerapan status premium.
 *
 * Alur: verifikasi signature DULU (body belum dipercaya sebelum lolos) →
 * JSON.parse → validasi envelope Zod → KLAIM IDEMPOTENSI (insert ke
 * paddle_events on conflict do nothing — replay di-acknowledge 200 tanpa
 * apply; remediasi audit 25 B2) → routing event:
 * - 'transaction.completed'   → verifikasi price_id vs allowlist →
 *   upsert paddle_transactions → applyPremiumStatus(userId, true);
 *   price di luar allowlist / allowlist kosong = transaksi dicatat
 *   'price_rejected' TANPA grant (fail-closed);
 * - 'subscription.canceled'   → applyPremiumStatus(userId, false);
 * - 'adjustment.created' /
 *   'adjustment.updated'      → refund/credit approved → tandai
 *   refunded_at + applyPremiumStatus(userId, false);
 * - event lain                → { ok:true, handled:false } — acknowledge,
 *   BUKAN error: idempoten & aman untuk event baru Paddle (menolaknya
 *   hanya memicu retry tanpa henti dari Paddle).
 *
 * Anti-info-disclosure (remediasi audit 23-c LOW): detail kegagalan
 * bentuk/zod hanya ke console.error — outcome TIDAK membawanya, sehingga
 * body 400 Edge Function bisa generik.
 *
 * Murni — tanpa import runtime Deno/Node apa pun (lolos vitest); efek
 * samping DB disuntik lewat db + applyPremiumStatus.
 */
export async function handlePaddleWebhook(input: RouterDeps): Promise<PaddleWebhookOutcome> {
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
    console.error('[paddle-webhook] invalid-json:', errorMessage(error));
    return { ok: false, reason: 'invalid-json' };
  }

  // 3. Envelope.
  const envelope = PaddleEnvelopeSchema.safeParse(parsedJson);
  if (!envelope.success) {
    console.error('[paddle-webhook] invalid-event:', formatIssues(envelope.error.issues));
    return { ok: false, reason: 'invalid-event' };
  }
  const eventType = envelope.data.event_type;

  // 4. IDEMPOTENSI (migrasi 0021, remediasi audit 25 B2): klaim event
  //    SEBELUM routing apa pun. Insert on conflict do nothing — bila tidak
  //    ada baris ter-insert berarti event_id ini pernah diproses (replay
  //    / retry Paddle) → acknowledge 200 'duplicate' TANPA apply.
  const claim = await input.db
    .from('paddle_events')
    .upsert(
      { event_id: envelope.data.event_id, event_type: eventType },
      { onConflict: 'event_id', ignoreDuplicates: true },
    )
    .select('event_id');
  if (claim.error !== null) {
    return {
      ok: false,
      reason: 'apply-failed',
      detail: `claim paddle_events gagal: ${claim.error.message}`,
    };
  }
  if ((claim.data?.length ?? 0) === 0) {
    return { ok: true, handled: false, eventType, status: 'duplicate' };
  }

  // 5. Routing.
  if (eventType === 'transaction.completed') {
    return handleTransactionCompleted(input, envelope.data.data, eventType);
  }
  if (eventType === 'subscription.canceled') {
    return handleSubscriptionCanceled(input, envelope.data.data, eventType);
  }
  if (eventType === 'adjustment.created' || eventType === 'adjustment.updated') {
    return handleAdjustment(input, envelope.data.data, eventType);
  }
  return { ok: true, handled: false, eventType };
}

// ============================================================
// Handler per event
// ============================================================

async function handleTransactionCompleted(
  input: RouterDeps,
  data: unknown,
  eventType: string,
): Promise<PaddleWebhookOutcome> {
  const dataParsed = TransactionCompletedDataSchema.safeParse(data);
  if (!dataParsed.success) {
    console.error(
      '[paddle-webhook] invalid-event (transaction.completed):',
      formatIssues(dataParsed.error.issues),
    );
    return { ok: false, reason: 'invalid-event' };
  }
  const mapping = extractUserId(data);
  if (!mapping.ok) {
    return { ok: false, reason: mapping.reason };
  }
  const firstItem = dataParsed.data.items[0];
  if (firstItem === undefined) {
    // Dijaga zod .min(1) — cabang ini hanya memuaskan TS, tak terjangkau.
    return { ok: false, reason: 'invalid-event' };
  }
  const priceId = firstItem.price.id;

  const row: PaddleTransactionRow = {
    transaction_id: dataParsed.data.id,
    user_id: mapping.userId,
    price_id: priceId,
    amount_total: dataParsed.data.amount_total ?? null,
    currency: dataParsed.data.currency ?? null,
    status: 'completed',
    refunded_at: null,
  };

  // ALLOWLIST (remediasi audit 25 MEDIUM): kosong = TIDAK terpasang =
  // tolak grant fail-closed; price di luar daftar = idem. Keduanya tetap
  // mencatat transaksi 'price_rejected' lalu 200 (event sah — hanya
  // keputusan grant yang ditolak; menolak delivery hanya memicu retry).
  const allowed = input.allowedPriceIds ?? [];
  if (allowed.length === 0) {
    console.error(
      '[paddle-webhook] price allowlist not configured — grant ditolak fail-closed ' +
        `(event transaction ${dataParsed.data.id})`,
    );
    row.status = 'price_rejected';
    const failure = await recordTransaction(input.db, row);
    if (failure !== null) {
      return failure;
    }
    return { ok: true, handled: true, eventType, userId: mapping.userId, status: 'price_rejected' };
  }
  if (!allowed.includes(priceId)) {
    console.error(
      `[paddle-webhook] price_id "${priceId}" tidak ada di allowlist — grant ditolak ` +
        `(event transaction ${dataParsed.data.id})`,
    );
    row.status = 'price_rejected';
    const failure = await recordTransaction(input.db, row);
    if (failure !== null) {
      return failure;
    }
    return { ok: true, handled: true, eventType, userId: mapping.userId, status: 'price_rejected' };
  }

  // Price terverifikasi: catat 'completed' DULU (audit trail), lalu grant.
  const failure = await recordTransaction(input.db, row);
  if (failure !== null) {
    return failure;
  }
  try {
    await input.applyPremiumStatus(mapping.userId, true);
  } catch (error) {
    return { ok: false, reason: 'apply-failed', detail: errorMessage(error) };
  }
  return { ok: true, handled: true, eventType, userId: mapping.userId, status: 'granted' };
}

async function handleSubscriptionCanceled(
  input: RouterDeps,
  data: unknown,
  eventType: string,
): Promise<PaddleWebhookOutcome> {
  const mapping = extractUserId(data);
  if (!mapping.ok) {
    return { ok: false, reason: mapping.reason };
  }
  try {
    await input.applyPremiumStatus(mapping.userId, false);
  } catch (error) {
    return { ok: false, reason: 'apply-failed', detail: errorMessage(error) };
  }
  return { ok: true, handled: true, eventType, userId: mapping.userId, status: 'revoked' };
}

async function handleAdjustment(
  input: RouterDeps,
  data: unknown,
  eventType: string,
): Promise<PaddleWebhookOutcome> {
  const dataParsed = AdjustmentDataSchema.safeParse(data);
  if (!dataParsed.success) {
    console.error(
      `[paddle-webhook] invalid-event (${eventType}):`,
      formatIssues(dataParsed.error.issues),
    );
    return { ok: false, reason: 'invalid-event' };
  }
  const { action, status, transaction_id: transactionId } = dataParsed.data;

  // Hanya refund/credit yang SUDAH approved yang mencabut premium;
  // pending/rejected/charge = tidak mengubah apa pun.
  if ((action === 'refund' || action === 'credit') && status === 'approved') {
    const found = await input.db
      .from('paddle_transactions')
      .select('user_id')
      .eq('transaction_id', transactionId)
      .limit(1);
    if (found.error !== null) {
      return {
        ok: false,
        reason: 'apply-failed',
        detail: `cari paddle_transactions gagal: ${found.error.message}`,
      };
    }
    const row = found.data?.[0];
    const userId = typeof row?.user_id === 'string' ? row.user_id : null;
    if (row === undefined || userId === null) {
      // Transaksi tak dikenal (mis. pra-0021 / uji sandbox) — log + 200:
      // event sah, menolaknya hanya memicu retry tanpa henti.
      console.warn(
        `[paddle-webhook] adjustment ${action} utk transaksi tak dikenal "${transactionId}" — di-acknowledge tanpa apply`,
      );
      return { ok: true, handled: false, eventType };
    }
    const marked = await input.db
      .from('paddle_transactions')
      .update({ refunded_at: new Date().toISOString() })
      .eq('transaction_id', transactionId);
    if (marked.error !== null) {
      return {
        ok: false,
        reason: 'apply-failed',
        detail: `tandai refunded_at gagal: ${marked.error.message}`,
      };
    }
    try {
      await input.applyPremiumStatus(userId, false);
    } catch (error) {
      return { ok: false, reason: 'apply-failed', detail: errorMessage(error) };
    }
    return { ok: true, handled: true, eventType, userId, status: 'revoked' };
  }
  return { ok: true, handled: false, eventType };
}

/** Upsert ledger transaksi; null = sukses, selain itu outcome apply-failed. */
async function recordTransaction(
  db: PaddleWebhookDbLike,
  row: PaddleTransactionRow,
): Promise<PaddleWebhookOutcome | null> {
  // Pemetaan eksplisit baris → Record: kolom PERSIS mengikuti 0021
  // (self-documenting; field baru wajib ditambahkan sadar di sini).
  const values: Record<string, unknown> = {
    transaction_id: row.transaction_id,
    user_id: row.user_id,
    price_id: row.price_id,
    amount_total: row.amount_total,
    currency: row.currency,
    status: row.status,
    refunded_at: row.refunded_at,
  };
  const response = await db
    .from('paddle_transactions')
    .upsert(values, { onConflict: 'transaction_id' });
  if (response.error !== null) {
    return {
      ok: false,
      reason: 'apply-failed',
      detail: `upsert paddle_transactions gagal: ${response.error.message}`,
    };
  }
  return null;
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
 * Detail mapping TIDAK dibawa outcome (hanya urutan reason yang stabil).
 */
function extractUserId(data: unknown): UserIdMapping {
  const dataParsed = EventDataSchema.safeParse(data);
  if (!dataParsed.success) {
    return { ok: false, reason: 'invalid-event' };
  }
  const userParsed = CustomDataUserIdSchema.safeParse(dataParsed.data.custom_data);
  if (!userParsed.success) {
    return { ok: false, reason: 'missing-user-id' };
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
