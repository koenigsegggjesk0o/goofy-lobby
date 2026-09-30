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
 * - beforeSend mengupas properti sensitif secara rekursif-dalam (remediasi
 *   25-a: extra, contexts, breadcrumbs[].data — kunci sensitif, userinfo
 *   URL, query param sensitif, string panjang) supaya kredensial tidak
 *   pernah sampai dashboard.
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
 * Menghapus kemungkinan kredensial dari event sebelum dikirim (remediasi
 * audit 23-c LOW-7 + 25-a): URL request dipangkas query-nya, lalu walker
 * rekursif-dalam menyikat `extra`, `contexts`, dan `breadcrumbs[i].data` —
 * kunci sensitif diganti '[difilter]', nilai string dibersihkan (userinfo
 * URL, query param sensitif, pemotongan > 2048 char).
 */
function scrubSentryEvent(event: Record<string, unknown>): Record<string, unknown> {
  const scrubbed: Record<string, unknown> = { ...event };
  const request = scrubbed.request as { url?: string } | undefined;
  if (typeof request?.url === 'string') {
    // Perilaku lama tetap: query string dibuang seluruhnya (origin+path);
    // tambahan: userinfo user:pass@ ikut diredaksi bila ada.
    const queryIndex = request.url.indexOf('?');
    const noQuery = queryIndex === -1 ? request.url : request.url.slice(0, queryIndex);
    const safeUrl = redactUrlUserinfo(noQuery);
    if (safeUrl !== request.url) {
      scrubbed.request = { ...request, url: safeUrl };
    }
  }
  const extra = scrubbed.extra;
  if (extra !== null && typeof extra === 'object') {
    scrubbed.extra = scrubDeep(extra, new Set());
  }
  const contexts = scrubbed.contexts;
  if (contexts !== null && typeof contexts === 'object') {
    scrubbed.contexts = scrubDeep(contexts, new Set());
  }
  if (Array.isArray(scrubbed.breadcrumbs)) {
    scrubbed.breadcrumbs = (scrubbed.breadcrumbs as unknown[]).map(scrubBreadcrumb);
  }
  return scrubbed;
}

/** Batas kedalaman walker (objek/array) — pertahanan atas payload ekstrem. */
const SCRUB_MAX_DEPTH = 6;

/** Batas panjang nilai string sebelum dipotong + sufiks (dicek SETELAH redaksi). */
const SCRUB_MAX_STRING_LENGTH = 2048;
const TRUNCATED_SUFFIX = '…[truncated]';

const SENSITIVE_KEY_PATTERN =
  /(token|secret|password|passwd|authorization|apikey|api_key|credential|session|jwt|private)/i;

/** userinfo URL (`scheme://user:pass@`) → `scheme://***:***@`. */
const URL_USERINFO_PATTERN = /(\/\/)[^/@:\s]+:[^/@:\s]+@/g;

/** Pasangan `key=value` di query string (sampai `&`/`#`/akhir). */
const URL_QUERY_PARAM_PATTERN = /([?&])([^=&#]+)=([^&#]*)/g;

function isSensitiveKey(key: string): boolean {
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    return true;
  }
  // Kunci query bisa percent-encoded (mis. api%5Fkey) — cek bentuk terurai.
  try {
    return SENSITIVE_KEY_PATTERN.test(decodeURIComponent(key));
  } catch {
    return false;
  }
}

function redactUrlUserinfo(value: string): string {
  return value.replace(URL_USERINFO_PATTERN, '$1***:***@');
}

/** Bersihkan satu nilai string: userinfo URL, query param sensitif, panjang. */
function scrubString(value: string): string {
  const noUserinfo = redactUrlUserinfo(value);
  const noSensitiveQuery = noUserinfo.replace(
    URL_QUERY_PARAM_PATTERN,
    (match, sep: string, key: string) => (isSensitiveKey(key) ? `${sep}${key}=[difilter]` : match),
  );
  if (noSensitiveQuery.length > SCRUB_MAX_STRING_LENGTH) {
    return noSensitiveQuery.slice(0, SCRUB_MAX_STRING_LENGTH) + TRUNCATED_SUFFIX;
  }
  return noSensitiveQuery;
}

/** Objek polos (bukan Date/Error/Map/dst.) — hanya ini yang di descend. */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Walker rekursif-dalam: cycle-safe via Set (rujukan bersama/berulang →
 * '[circular]'), depth cap SCRUB_MAX_DEPTH. Nilai non-plain-object
 * (Date/Error/dll.) diteruskan apa adanya — tidak pernah di-stringify
 * sehingga tidak membocorkan lebih dari kondisi sebelumnya.
 */
function scrubDeep(value: unknown, seen: Set<object>, depth: number = 0): unknown {
  if (typeof value === 'string') {
    return scrubString(value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (depth >= SCRUB_MAX_DEPTH) {
    return value;
  }
  if (seen.has(value)) {
    return '[circular]';
  }
  if (!isPlainObject(value) && !Array.isArray(value)) {
    return value;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => scrubDeep(item, seen, depth + 1));
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = isSensitiveKey(key) ? '[difilter]' : scrubDeep(item, seen, depth + 1);
  }
  return result;
}

/** Satu breadcrumb: hanya field `data` yang disikat (objek ataupun array). */
function scrubBreadcrumb(crumb: unknown): unknown {
  if (crumb === null || typeof crumb !== 'object') {
    return crumb;
  }
  const record = crumb as { data?: unknown };
  if (record.data === null || typeof record.data !== 'object') {
    return crumb;
  }
  return { ...record, data: scrubDeep(record.data, new Set()) };
}
