/**
 * Pembacaan environment variable klien (VITE_*) dengan validasi eksplisit.
 * Gagal keras saat wajib kosong — sesuai protokol anti-halusinasi:
 * lebih baik error jelas di awal daripada jalan dengan nilai kosong.
 */
export interface ClientEnv {
  supabaseUrl: string;
  supabaseAnonKey: string;
  turnstileSiteKey: string | undefined;
  sentryDsn: string | undefined;
}

export class MissingClientEnvError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(
      `Environment variable klien belum lengkap: ${missing.join(', ')} — ` +
        'salin .env.example menjadi .env lalu isi nilainya.',
    );
    this.name = 'MissingClientEnvError';
    this.missing = missing;
  }
}

function readRequired(
  source: Record<string, string | undefined>,
  name: string,
  missing: string[],
): string {
  const value = source[name]?.trim();
  if (value === undefined || value === '') {
    missing.push(name);
    return '';
  }
  return value;
}

function readOptional(
  source: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const value = source[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Membaca env klien dari `source` (default: import.meta.env milik Vite).
 * Melempar MissingClientEnvError bila variabel wajib tidak terisi.
 */
export function readClientEnv(
  source: Record<string, string | undefined> = import.meta.env,
): ClientEnv {
  const missing: string[] = [];
  const supabaseUrl = readRequired(source, 'VITE_SUPABASE_URL', missing);
  const supabaseAnonKey = readRequired(source, 'VITE_SUPABASE_ANON_KEY', missing);
  if (missing.length > 0) {
    throw new MissingClientEnvError(missing);
  }
  return {
    supabaseUrl,
    supabaseAnonKey,
    turnstileSiteKey: readOptional(source, 'VITE_TURNSTILE_SITE_KEY'),
    sentryDsn: readOptional(source, 'VITE_SENTRY_DSN'),
  };
}
