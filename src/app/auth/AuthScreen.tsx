/**
 * Layar masuk — jalur utama OAuth (Google/Facebook/Apple/Discord) dengan
 * logo resmi, satu klik langsung lanjut. Struktur kartu dua kolom mengikuti
 * bahasa desain referensi UI (kolom form + panel brand, token Drive).
 * Email/password tetap tersedia lewat toggle untuk akun terdaftar.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { sb } from '../lib/services';
import { readClientEnv } from '../../lib/env';
import { Icon } from '../lib/icons';

type OAuthProvider = 'google' | 'facebook' | 'apple' | 'discord';

/** Logo Google resmi (G empat warna). */
function GoogleLogo(): ReactNode {
  return (
    <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        fill="#4285F4"
        d="M17.64 9.2045c0-.6381-.0573-1.2518-.1636-1.8409H9v3.4773h4.8436c-.2086 1.125-.8427 2.0786-1.7959 2.7164v2.2582h2.9086c1.7018-1.5668 2.6813-3.8741 2.6813-6.611z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.4295 0 4.4695-.8059 5.9559-2.1823l-2.9086-2.2582c-.8059.54-1.8368.8591-3.0473.8591-2.3436 0-4.3268-1.5823-5.0345-3.7105H.9573v2.3318C2.4386 16.1523 5.4818 18 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.9655 10.7082c-.18-.54-.2823-1.1168-.2823-1.7082s.1023-1.1682.2823-1.7082V4.96H.9573C.3477 6.1732 0 7.5477 0 9s.3477 2.8268.9573 4.04l3.0082-2.3318z"
      />
      <path
        fill="#EA4335"
        d="M9 3.5795c1.3214 0 2.5068.4541 3.4405 1.3459l2.5813-2.5814C13.4659.9018 11.4295 0 9 0 5.4818 0 2.4386 1.8482.9573 4.96l3.0082 2.3318C4.6732 5.1636 6.6564 3.5795 9 3.5795z"
      />
    </svg>
  );
}

/** Logo Facebook resmi (f putih dalam lingkaran biru). */
function FacebookLogo(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        fill="#1877F2"
        d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"
      />
    </svg>
  );
}

/** Logo Apple resmi (apel putih). */
function AppleLogo(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" fill="#fff">
      <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
    </svg>
  );
}

/** Logo Discord resmi (marka blurple). */
function DiscordLogo(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        fill="#5865F2"
        d="M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.058a.082.082 0 0 0 .031.056 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.009c.12.099.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.029zM8.02 15.331c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"
      />
    </svg>
  );
}

interface OAuthButtonSpec {
  provider: OAuthProvider;
  label: string;
  short: string;
  logo: ReactNode;
}

const OAUTH_BUTTONS: OAuthButtonSpec[] = [
  { provider: 'google', label: 'Lanjut dengan Google', short: 'Google', logo: <GoogleLogo /> },
  { provider: 'facebook', label: 'Lanjut dengan Facebook', short: 'Facebook', logo: <FacebookLogo /> },
  { provider: 'apple', label: 'Lanjut dengan Apple', short: 'Apple', logo: <AppleLogo /> },
  { provider: 'discord', label: 'Lanjut dengan Discord', short: 'Discord', logo: <DiscordLogo /> },
];

function mapAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('invalid login credentials')) return 'Email atau password salah';
  if (m.includes('already registered')) return 'Email sudah terdaftar — masuk saja';
  if (m.includes('password should be')) return 'Password minimal 6 karakter';
  if (m.includes('unable to validate email')) return 'Format email tidak valid';
  if (m.includes('rate limit')) return 'Terlalu banyak percobaan — tunggu sebentar';
  return 'Gagal — coba lagi sebentar';
}

function mapOAuthError(message: string, provider: string): string {
  const m = message.toLowerCase();
  if (m.includes('not enabled') || m.includes('unsupported provider') || m.includes('403')) {
    return (
      `Login ${provider} belum diaktifkan di server — admin perlu memasang ` +
      'kuncinya dulu (docs/deploy-checklist.md bagian k).'
    );
  }
  if (m.includes('popup closed') || m.includes('popup')) return 'Jendela login ditutup — coba lagi';
  return 'Gagal membuka halaman login — coba lagi sebentar';
}

export default function AuthScreen(): ReactNode {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [showEmail, setShowEmail] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Provider yang aktif di server (GET /auth/v1/settings) — null = belum tau. */
  const [available, setAvailable] = useState<Record<OAuthProvider, boolean> | null>(null);

  // Cek provider OAuth yang aktif SEKALI per layar — supaya klik pada
  // provider yang belum dikonfigurasi menampilkan pesan sopan, bukan
  // halaman JSON error dari server (signInWithOAuth mengarahkan browser
  // langsung ke /auth/v1/authorize).
  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const env = readClientEnv();
        const res = await fetch(`${env.supabaseUrl}/auth/v1/settings`, {
          headers: { apikey: env.supabaseAnonKey },
        });
        if (!res.ok) return;
        const data = (await res.json()) as { external?: Record<string, boolean> };
        if (!alive || data.external === undefined) return;
        setAvailable({
          google: data.external.google === true,
          facebook: data.external.facebook === true,
          apple: data.external.apple === true,
          discord: data.external.discord === true,
        });
      } catch {
        // Biarkan null — tombol tetap bisa dicoba (fallback perilaku normal).
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, []);

  const startOAuth = async (spec: OAuthButtonSpec): Promise<void> => {
    if (busy) return;
    if (available !== null && !available[spec.provider]) {
      setError(
        `Login ${spec.short} belum diaktifkan di server — admin perlu memasang ` +
          'kuncinya dulu (docs/deploy-checklist.md bagian k).',
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Berhasil = browser meninggalkan halaman menuju penyedia OAuth.
      const { error: oauthError } = await sb().auth.signInWithOAuth({
        provider: spec.provider,
        options: { redirectTo: window.location.origin },
      });
      if (oauthError !== null) setError(mapOAuthError(oauthError.message, spec.short));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal terhubung — cek koneksi');
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (mode === 'register' && displayName.trim().length < 2) {
      setError('Nama tampilan minimal 2 karakter');
      return;
    }
    setBusy(true);
    setError(null);
    const finish = (): void => setBusy(false);
    if (mode === 'login') {
      sb()
        .auth.signInWithPassword({ email: email.trim(), password })
        .then(({ error: authError }) => {
          if (authError !== null) setError(mapAuthError(authError.message));
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : 'Gagal terhubung — cek koneksi');
        })
        .finally(finish);
    } else {
      sb()
        .auth.signUp({
          email: email.trim(),
          password,
          options: { data: { display_name: displayName.trim() } },
        })
        .then(({ error: authError }) => {
          if (authError !== null) setError(mapAuthError(authError.message));
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : 'Gagal terhubung — cek koneksi');
        })
        .finally(finish);
    }
  };

  return (
    <div className="auth" role="main">
      <div className="auth__card">
        <div className="auth__form-wrap">
          <form className="auth__form" onSubmit={onSubmit} noValidate>
            <h1 className="auth__title">
              {mode === 'login' ? 'Senang melihatmu lagi!' : 'Buat akun, ajak temanmu ngobrol.'}
            </h1>
            <p className="auth__subtitle">
              {showEmail
                ? 'Masuk dengan email dan password kamu.'
                : 'Klik layanan favoritmu — sekali lanjut, langsung masuk.'}
            </p>

            <div className="auth__oauth">
              {OAUTH_BUTTONS.map((spec) => (
                <button
                  key={spec.provider}
                  type="button"
                  className="auth__oauthbtn"
                  disabled={busy}
                  onClick={() => void startOAuth(spec)}
                >
                  {spec.logo}
                  {spec.label}
                </button>
              ))}
            </div>

            <div className="auth__divider" aria-hidden="true">
              atau
            </div>

            {showEmail ? (
              <>
                {mode === 'register' ? (
                  <label className="field">
                    <span className="field__label">NAMA TAMPILAN</span>
                    <input
                      className="field__input"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      maxLength={32}
                      autoComplete="nickname"
                      placeholder="Namamu di goofy"
                    />
                  </label>
                ) : null}

                <label className="field">
                  <span className="field__label">EMAIL</span>
                  <input
                    className="field__input"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    placeholder="nama@email.com"
                    required
                  />
                </label>

                <label className="field">
                  <span className="field__label">PASSWORD</span>
                  <input
                    className="field__input"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                    placeholder="••••••••"
                    required
                  />
                </label>

                {error !== null ? (
                  <p className="auth__error" role="alert">
                    {error}
                  </p>
                ) : null}

                <button className="btn btn--primary auth__submit" type="submit" disabled={busy}>
                  {busy ? <span className="spinner spinner--sm" aria-hidden="true" /> : null}
                  {mode === 'login' ? 'Masuk' : 'Daftar'}
                </button>

                <p className="auth__switch">
                  {mode === 'login' ? 'Butuh akun?' : 'Sudah punya akun?'}{' '}
                  <button
                    type="button"
                    className="auth__link"
                    onClick={() => {
                      setMode(mode === 'login' ? 'register' : 'login');
                      setError(null);
                    }}
                  >
                    {mode === 'login' ? 'Daftar' : 'Masuk'}
                  </button>
                </p>
              </>
            ) : (
              <>
                {error !== null ? (
                  <p className="auth__error" role="alert">
                    {error}
                  </p>
                ) : null}
                <button
                  type="button"
                  className="auth__emailtoggle"
                  onClick={() => {
                    setShowEmail(true);
                    setError(null);
                  }}
                >
                  Masuk dengan email saja
                </button>
              </>
            )}
          </form>
        </div>

        <aside className="auth__brand">
          <img
            className="auth__brand-logo"
            src="/logo.svg"
            alt="Logo goofy"
            width="84"
            height="84"
          />
          <h2 className="auth__brand-name">goofy</h2>
          <p className="auth__brand-sub">
            Panggil teman, seret posisimu di ruang — dengar dari arah suaranya berdiri.
          </p>
          <ul className="auth__feats">
            <li className="auth__feat">
              <Icon name="phone" size={16} />
              <span>Panggilan suara langsung dari DM</span>
            </li>
            <li className="auth__feat">
              <Icon name="friends" size={16} />
              <span>Cari teman lewat nama tampilan</span>
            </li>
            <li className="auth__feat">
              <Icon name="speaker" size={16} />
              <span>Audio spasial — kiri, kanan, jauh, dekat</span>
            </li>
          </ul>
        </aside>
      </div>
    </div>
  );
}
