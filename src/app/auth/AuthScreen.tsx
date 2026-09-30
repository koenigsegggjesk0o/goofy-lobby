/**
 * Layar masuk — login / daftar + akun demo cepat (QA users publik).
 * Desain: kartu gelap tengah + panel ilustrasi, bahasa referensi UI.
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import { sb } from '../lib/services';
import { useApp } from '../state/store';
import { Icon } from '../lib/icons';

interface DemoAccount {
  name: string;
  email: string;
  password: string;
  color: string;
}

const DEMO_ACCOUNTS: DemoAccount[] = [
  { name: 'Alya', email: 'qa.alpha@goofy.example.com', password: 'goofy-demo-1', color: '#e67146' },
  { name: 'Bagas', email: 'qa.bravo@goofy.example.com', password: 'goofy-demo-2', color: '#23a55a' },
  { name: 'Citra', email: 'qa.charlie@goofy.example.com', password: 'goofy-demo-3', color: '#5865f2' },
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

export default function AuthScreen(): ReactNode {
  const { user } = useApp();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (submitEmail: string, submitPassword: string, submitName?: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'login' || submitName === undefined) {
        const { error: authError } = await sb().auth.signInWithPassword({
          email: submitEmail,
          password: submitPassword,
        });
        if (authError !== null) setError(mapAuthError(authError.message));
      } else {
        const { error: authError } = await sb().auth.signUp({
          email: submitEmail,
          password: submitPassword,
          options: { data: { display_name: submitName } },
        });
        if (authError !== null) setError(mapAuthError(authError.message));
      }
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
    void submit(email.trim(), password, mode === 'register' ? displayName.trim() : undefined);
  };

  const demoLogin = (account: DemoAccount): void => {
    setMode('login');
    setEmail(account.email);
    setPassword(account.password);
    void submit(account.email, account.password);
  };

  return (
    <div className="auth" role="main">
      <div className="auth__card">
        <div className="auth__form-wrap">
          <form className="auth__form" onSubmit={onSubmit} noValidate>
            <h1 className="auth__title">goofy</h1>
            <p className="auth__subtitle">
              {mode === 'login' ? 'Senang melihatmu lagi!' : 'Buat akun, ajak temanmu ngobrol.'}
            </p>

            <label className="field">
              {mode === 'register' ? <span className="field__label">NAMA TAMPILAN</span> : null}
              {mode === 'register' ? (
                <input
                  className="field__input"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  maxLength={32}
                  autoComplete="nickname"
                  placeholder="Namamu di goofy"
                />
              ) : null}
            </label>

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

            <div className="auth__demo">
              <p className="auth__demo-label">
                <Icon name="friends" size={16} /> Coba cepat — akun demo publik
              </p>
              <div className="auth__demo-row">
                {DEMO_ACCOUNTS.map((account) => (
                  <button
                    key={account.email}
                    type="button"
                    className="auth__demo-chip"
                    onClick={() => demoLogin(account)}
                    disabled={busy || user !== null}
                    title={`Masuk sebagai ${account.name}`}
                  >
                    <span className="avatar__img avatar__img--24" style={{ ['--av-c' as string]: account.color }}>
                      {account.name.slice(0, 1)}
                    </span>
                    {account.name}
                  </button>
                ))}
              </div>
              <p className="auth__demo-note">
                Buka dua tab dengan akun berbeda untuk mencoba telepon & audio spasial.
              </p>
            </div>
          </form>
        </div>

        <aside className="auth__art" aria-hidden="true">
          <div className="auth__orbit">
            <span className="auth__blob auth__blob--a" />
            <span className="auth__blob auth__blob--b" />
            <span className="auth__face auth__face--1" style={{ ['--av-c' as string]: '#e67146' }}>A</span>
            <span className="auth__face auth__face--2" style={{ ['--av-c' as string]: '#23a55a' }}>B</span>
            <span className="auth__face auth__face--3" style={{ ['--av-c' as string]: '#5865f2' }}>C</span>
          </div>
          <h2 className="auth__art-title">dengar arah suaranya</h2>
          <p className="auth__art-sub">
            Panggil teman, seret posisimu di ruang — suara mengikuti dari mana ia berdiri.
          </p>
        </aside>
      </div>
    </div>
  );
}
