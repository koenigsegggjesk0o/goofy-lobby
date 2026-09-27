import * as Sentry from '@sentry/browser';

import { pushTrailLog } from './trail-log';

// ============================================================
// Konstanta
// ============================================================

/** Lingkungan default bila tidak ditentukan (Vite dev). */
export const DEFAULT_ENVIRONMENT = 'development' as const;

/** Batas waktu flush default (ms) saat menutup sesi/halaman. */
export const DEFAULT_FLUSH_TIMEOUT_MS = 2_000;

// ============================================================
// Kontrak struktural (fake test dapat menyuntik SDK palsu;
// namespace `* as Sentry` asli assignable tanpa cast)
// ============================================================

export interface SentryScopeLike {
  setContext(name: string, context: Record<string, unknown> | null): unknown;
  setTag(key: string, value: string): unknown;
  setLevel?(level: string): unknown;
}

export interface SentrySdkLike {
  init(options?: unknown): unknown;
  isInitialized(): boolean;
  isEnabled(): boolean;
  captureException(exception: unknown, hint?: unknown): string;
  captureMessage?(message: string, captureContext?: unknown): string;
  addBreadcrumb(breadcrumb: unknown): void;
  withScope(callback: (scope: SentryScopeLike) => void): void;
  flush(timeout?: number): Promise<boolean>;
}

export interface InitMonitoringOptions {
  /** Dipakai untuk membedakan event dev/preview/produksi di dashboard. */
  environment?: string;
  /** Release/sha commit — ditampilkan per event di dashboard. */
  release?: string;
  /** Aktifkan breadcrumbs otomatis (klik/navigasi/console). Default: true. */
  breadcrumbs?: boolean;
}

export interface InitMonitoringResult {
  /** true bila init benar-benar dijalankan. */
  initialized: boolean;
  /** Alasan init dilewati (dsn kosong / sudah pernah init). */
  skipped: null | 'empty-dsn' | 'already-initialized';
}

export interface CaptureDetail {
  /** Nama panggilan/konteks logis, mis. 'voice-recorder', 'mesh-room'. */
  context?: string;
  /** Pasangan kunci-nilai tambahan untuk dashboard. */
  data?: Record<string, unknown>;
}

// ============================================================
// State modul
// ============================================================

let activeSdk: SentrySdkLike = Sentry;

/**
 * Menyuntik SDK pengganti (khusus test). Mengembalikan pemulih fungsi
 * yang mengembalikan SDK asli — dipanggil di afterEach test.
 */
export function __setSdkForTests(sdk: SentrySdkLike): () => void {
  activeSdk = sdk;
  return () => {
    activeSdk = Sentry;
  };
}

// ============================================================
// API publik
// ============================================================

/**
 * Menginisialisasi Sentry error monitoring (sekali per halaman).
 *
 * - DSN kosong/undefined → no-op terdokumentasi (dev tanpa DSN) —
 *   semua helper tetap aman dipanggil.
 * - Sudah ter-init → dilewati (idempoten), alasan dilaporkan.
 * - Hanya error monitoring: tracesSampleRate 0, tanpa replay/feedback.
 * - beforeSend mengupas properti sensitif (token/query URL) — pertahanan
 *   sederhana supaya kredensial tidak pernah sampai dashboard.
 */
export function initMonitoring(
  dsn: string | undefined,
  options: InitMonitoringOptions = {},
  sdk: SentrySdkLike = activeSdk,
): InitMonitoringResult {
  const trimmed = dsn?.trim();
  if (trimmed === undefined || trimmed === '') {
    return { initialized: false, skipped: 'empty-dsn' };
  }
  if (sdk.isInitialized()) {
    return { initialized: false, skipped: 'already-initialized' };
  }
  sdk.init({
    dsn: trimmed,
    environment: options.environment ?? DEFAULT_ENVIRONMENT,
    release: options.release,
    tracesSampleRate: 0,
    sendClientReports: true,
    ...(options.breadcrumbs === false ? { defaultIntegrations: false } : {}),
    beforeSend(event: unknown) {
      return scrubSentryEvent(event as Record<string, unknown>);
    },
  });
  return { initialized: true, skipped: null };
}

/**
 * Menangkap error untuk dashboard — selalu aman dipanggil bahkan sebelum
 * init (menjadi no-op di SDK). `detail` menempel context + data pada
 * event (via withScope, tidak bocor ke event berikutnya).
 * @returns event id (string kosong bila SDK tidak aktif).
 */
export function captureError(error: unknown, detail: CaptureDetail = {}): string {
  try {
    if (detail.context === undefined && detail.data === undefined) {
      return activeSdk.captureException(error);
    }
    let eventId = '';
    activeSdk.withScope((scope) => {
      if (detail.context !== undefined) {
        scope.setContext(detail.context, detail.data ?? {});
      } else if (detail.data !== undefined) {
        scope.setContext('detail', detail.data);
      }
      eventId = activeSdk.captureException(error);
    });
    return eventId;
  } catch {
    // Monitoring tidak boleh menjatuhkan pemanggilnya — apa pun yang
    // terjadi di SDK, aplikasi tetap berjalan.
    return '';
  }
}

/**
 * Menambahkan jejak ringan (breadcrumb) untuk konteks error di dashboard.
 * No-op aman bila SDK belum init. Level default 'info' (mis. event mesh
 * 'error' dikirim 'error' — lihat mesh-trail.ts).
 *
 * Task 10-a: setiap pemanggilan juga tercatat ke ring lokal trail-log
 * (SEBELUM SDK) supaya jejak tetap teramati tanpa DSN — dashboard-side
 * tetap butuh DSN, app-side kini terverifikasi e2e no-auth.
 */
export function addTrail(
  message: string,
  data?: Record<string, unknown>,
  category = 'app',
  level: 'info' | 'error' = 'info',
): void {
  pushTrailLog(message, data, category, level);
  try {
    activeSdk.addBreadcrumb({
      message,
      category,
      level,
      ...(data === undefined ? {} : { data }),
    });
  } catch {
    // Idem — jangan pernah melempar.
  }
}

/** Menunggu antrean event terkirim (dipanggil saat beforeunload). */
export async function flushMonitoring(
  timeoutMs: number = DEFAULT_FLUSH_TIMEOUT_MS,
): Promise<boolean> {
  try {
    return await activeSdk.flush(timeoutMs);
  } catch {
    return false;
  }
}

/** Status monitoring untuk harness/metrics (bukan untuk UI). */
export function monitoringStatus(): { initialized: boolean; enabled: boolean } {
  try {
    return { initialized: activeSdk.isInitialized(), enabled: activeSdk.isEnabled() };
  } catch {
    return { initialized: false, enabled: false };
  }
}

// ============================================================
// Internal
// ============================================================

/**
 * Menghapus kemungkinan kredensial dari event sebelum dikirim:
 * URL dengan query string dipangkas ke origin+path, kunci extra yang
 * menyerupai token dibersihkan.
 */
function scrubSentryEvent(event: Record<string, unknown>): Record<string, unknown> {
  const scrubbed: Record<string, unknown> = { ...event };
  const request = scrubbed.request as { url?: string } | undefined;
  if (typeof request?.url === 'string' && request.url.includes('?')) {
    scrubbed.request = { ...request, url: request.url.split('?')[0] };
  }
  const extra = scrubbed.extra as Record<string, unknown> | undefined;
  if (extra !== undefined && extra !== null) {
    scrubbed.extra = scrubRecord(extra);
  }
  return scrubbed;
}

const SENSITIVE_KEY_PATTERN = /token|secret|password|authorization|apikey|api_key/i;

function scrubRecord(record: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[difilter]' : value;
  }
  return result;
}
