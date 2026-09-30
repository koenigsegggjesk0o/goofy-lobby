import { Component, useCallback, useState, type ErrorInfo, type ReactNode } from 'react';
import { MissingClientEnvError, readClientEnv } from './lib/env';
import { AppProvider, useApp } from './app/state/store';
import { CallProvider } from './app/state/call';
import { ToastProvider } from './app/state/toast';
import AuthScreen from './app/auth/AuthScreen';
import AppShell from './app/shell/AppShell';
import { Icon } from './app/lib/icons';

/** Hasil pemeriksaan env klien — dijalankan sekali saat render pertama. */
type EnvCheck =
  | { ok: true }
  | { ok: false; missing: readonly string[]; message: string };

function checkEnv(): EnvCheck {
  try {
    readClientEnv();
    return { ok: true };
  } catch (error) {
    if (error instanceof MissingClientEnvError) {
      return { ok: false, missing: error.missing, message: error.message };
    }
    return {
      ok: false,
      missing: [],
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Hostname saat ini — 'localhost' bila tak terbaca. */
function currentHost(): string {
  try {
    return window.location.hostname;
  } catch {
    return 'localhost';
  }
}

/** True bila jalan di konteks dev (lokal / gateway sandbox) — bukan deploy publik. */
function isDevHost(): boolean {
  const host = currentHost();
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host.endsWith('.local') ||
    host.endsWith('.fcapp.run')
  );
}

/** Tombol salin kecil dengan umpan balik "Tersalin". */
function CopyButton({ value }: { value: string }): ReactNode {
  const [copied, setCopied] = useState(false);

  const copy = useCallback((): void => {
    const showCopied = (): void => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    };
    // Fallback untuk konteks non-secure (http) tanpa Clipboard API.
    const fallback = (): void => {
      const area = document.createElement('textarea');
      area.value = value;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try {
        if (document.execCommand('copy')) showCopied();
      } finally {
        area.remove();
      }
    };
    if (navigator.clipboard?.writeText !== undefined) {
      navigator.clipboard.writeText(value).then(showCopied, fallback);
    } else {
      fallback();
    }
  }, [value]);

  return (
    <button type="button" className="setup__copy" onClick={copy}>
      <Icon name={copied ? 'check' : 'copy'} size={14} />
      {copied ? 'Tersalin' : 'Salin'}
    </button>
  );
}

/**
 * Layar setup env — BUKAN white screen: panduan langkah demi langkah yang
 * menyesuaikan konteks (dev lokal → .env; host publik/Vercel → dashboard
 * Vercel + redeploy). Variabel VITE_* memang publik by-design.
 */
function SetupScreen({ missing }: { missing: readonly string[] }): ReactNode {
  const dev = isDevHost();
  const host = currentHost();

  return (
    <div className="setup" role="alert">
      <div className="setup__card">
        <div className="setup__head">
          <span className="setup__logo">goofy</span>
          <span className="setup__badge" title={host}>
            {dev ? 'pengembangan lokal' : host}
          </span>
        </div>

        <h1 className="setup__title">Belum terkonfigurasi</h1>
        <p className="setup__sub">
          Variabel lingkungan berikut belum terisi, jadi goofy belum bisa menyala.
          Nilainya publik (bukan rahasia) — diambil dari dashboard Supabase, lalu
          ditempel di {dev ? 'file .env proyek' : 'pengaturan deployment'}.
        </p>

        <div className="setup__vars">
          {missing.map((name) => (
            <div key={name} className="setup__varrow">
              <code className="setup__varname">{name}</code>
              <CopyButton value={name} />
            </div>
          ))}
        </div>

        {dev ? (
          <ol className="setup__steps">
            <li>
              Di root proyek: salin <code>.env.example</code> menjadi <code>.env</code>.
            </li>
            <li>
              Isi nilainya dari <strong>Supabase → Settings → API</strong> —{' '}
              <em>Project URL</em> dan <em>anon public</em> key.
            </li>
            <li>
              Jalankan ulang <code>bun run dev</code>.
            </li>
          </ol>
        ) : (
          <ol className="setup__steps">
            <li>
              Buka <strong>vercel.com</strong> → project ini →{' '}
              <strong>Settings → Environment Variables</strong>.
            </li>
            <li>
              Tambahkan kedua variabel di atas (nilainya dari{' '}
              <strong>Supabase → Settings → API</strong>: Project URL + anon public
              key).
            </li>
            <li>
              Buka <strong>Deployments</strong> → deploy terbaru → menu{' '}
              <strong>⋯</strong> → <strong>Redeploy</strong> — env dibaca saat
              build, jadi redeploy wajib setelah mengisi.
            </li>
          </ol>
        )}

        <p className="setup__note">
          Sudah terisi tapi layar ini masih muncul? Pastikan variabel ditambahkan
          sebelum build, lalu redeploy. Panduan lengkap + variabel opsional:{' '}
          <code>docs/deploy-checklist.md</code> bagian j.
        </p>
      </div>
    </div>
  );
}

/** Layar error generik (env bermasalah di luar variabel yang hilang). */
function EnvErrorScreen({ message }: { message: string }): ReactNode {
  return (
    <div className="enverror" role="alert">
      <h1>goofy belum terkonfigurasi</h1>
      <p>{message}</p>
      <p>
        Salin <code>.env.example</code> menjadi <code>.env</code> lalu isi{' '}
        <code>VITE_SUPABASE_URL</code> dan <code>VITE_SUPABASE_ANON_KEY</code>.
      </p>
    </div>
  );
}

/** Error boundary — jaga agar crash render tidak pernah jadi layar putih. */
class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[goofy] crash render:', error, info.componentStack);
  }
  render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="enverror" role="alert">
          <h1>Waduh, ada yang error</h1>
          <p>{this.state.error.message}</p>
          <button className="btn btn--primary" onClick={() => this.setState({ error: null })}>
            Coba lagi
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Pintu auth: loading → layar masuk → aplikasi. */
function Gate(): ReactNode {
  const { ready, user } = useApp();
  if (!ready) {
    return (
      <div className="boot" role="status" aria-label="Memuat goofy">
        <span className="boot__logo">goofy</span>
        <span className="spinner" aria-hidden="true" />
      </div>
    );
  }
  if (user === null) return <AuthScreen />;
  return <AppShell />;
}

export default function App(): ReactNode {
  const [envCheck] = useState(checkEnv);
  if (!envCheck.ok) {
    return envCheck.missing.length > 0 ? (
      <SetupScreen missing={envCheck.missing} />
    ) : (
      <EnvErrorScreen message={envCheck.message} />
    );
  }
  return (
    <Boundary>
      <ToastProvider>
        <AppProvider>
          <CallProvider>
            <Gate />
          </CallProvider>
        </AppProvider>
      </ToastProvider>
    </Boundary>
  );
}
