import { Component, useState, type ErrorInfo, type ReactNode } from 'react';
import { readClientEnv } from './lib/env';
import { AppProvider, useApp } from './app/state/store';
import { CallProvider } from './app/state/call';
import { ToastProvider } from './app/state/toast';
import AuthScreen from './app/auth/AuthScreen';
import AppShell from './app/shell/AppShell';

/** Cek env sekali saat render pertama — null bila lengkap. */
function useEnvError(): string | null {
  return useState(() => {
    try {
      readClientEnv();
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  })[0];
}

/** Layar konfigurasi jelas (bukan white-screen) bila env belum diisi. */
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
  const envError = useEnvError();
  if (envError !== null) return <EnvErrorScreen message={envError} />;
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
