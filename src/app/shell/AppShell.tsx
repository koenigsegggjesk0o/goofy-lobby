/** Kerangka aplikasi — grid topbar/rail/sidebar/main + overlay global. */
import type { ReactNode } from 'react';
import { useApp } from '../state/store';
import { useCall } from '../state/call';
import { useToast } from '../state/toast';
import ServerRail from './ServerRail';
import Sidebar from './Sidebar';
import FriendsView from '../friends/FriendsView';
import ChatView from '../dm/ChatView';
import HubView from '../room/HubView';
import ProfilePopout from '../friends/ProfilePopout';
import SettingsModal from '../settings/SettingsModal';
import CallOverlay from '../call/CallOverlay';
import { Icon } from '../lib/icons';

export default function AppShell(): ReactNode {
  const { view, popout, settingsOpen } = useApp();
  const { snapshot, incoming } = useCall();

  return (
    <div className="app" role="application" aria-label="goofy">
      <TopBar />
      <ServerRail />
      <Sidebar />
      <main className="chat">
        {view.kind === 'friends' ? <FriendsView /> : null}
        {view.kind === 'dm' ? <ChatView key={view.userId} userId={view.userId} /> : null}
        {view.kind === 'hub' ? <HubView /> : null}
      </main>

      {popout !== null ? <ProfilePopout /> : null}
      {settingsOpen ? <SettingsModal /> : null}
      {incoming !== null || snapshot.status !== 'idle' ? <CallOverlay /> : null}
    </div>
  );
}

function crumbOf(view: { kind: string }): { icon: 'friends' | 'speaker'; label: string } {
  if (view.kind === 'dm') return { icon: 'friends', label: 'Pesan Langsung' };
  if (view.kind === 'hub') return { icon: 'speaker', label: 'goofy hub — room suara' };
  return { icon: 'friends', label: 'Teman' };
}

function TopBar(): ReactNode {
  const { view, dms } = useApp();
  const { toast } = useToast();
  const crumb = crumbOf(view);
  const unreadTotal = dms.reduce((sum, d) => sum + d.unread, 0);

  return (
    <header className="topbar" role="banner">
      <div className="topbar__left">
        <button
          className="iconbtn iconbtn--topbar topbar__menu"
          aria-label="Buka panel samping"
          onClick={() => document.documentElement.classList.toggle('sb-open')}
        >
          <Icon name="menu" size={18} />
        </button>
        <span className="topbar__crumb" aria-hidden="true">
          <Icon name={crumb.icon} size={16} />
          <span className="topbar__crumb-label">{crumb.label}</span>
        </span>
      </div>
      <div className="topbar__right">
        <button
          className="iconbtn iconbtn--topbar"
          aria-label={`Kotak masuk${unreadTotal > 0 ? ` — ${String(unreadTotal)} belum dibaca` : ''}`}
          title="Kotak masuk"
          onClick={() =>
            toast(
              unreadTotal > 0
                ? `${String(unreadTotal)} pesan belum dibaca — cek daftar Pesan Langsung`
                : 'Belum ada notifikasi baru',
              'info',
            )
          }
        >
          <Icon name="bell" size={18} />
          {unreadTotal > 0 ? <span className="topbar__badge">{unreadTotal > 9 ? '9+' : unreadTotal}</span> : null}
        </button>
        <button
          className="iconbtn iconbtn--topbar"
          aria-label="Bantuan"
          title="Bantuan"
          onClick={() =>
            toast('Telepon: ikon 📞 di teman / chat · Spasial: seret bolamu di ruang · Room: tab hub', 'info')
          }
        >
          <Icon name="help" size={18} />
        </button>
      </div>
    </header>
  );
}
