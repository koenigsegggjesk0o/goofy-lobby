/** Sidebar kiri — navigasi, daftar DM, panel user (mute/deafen/pengaturan). */
import type { ReactNode } from 'react';
import { useApp } from '../state/store';
import { useCall } from '../state/call';
import { Icon } from '../lib/icons';

function hiddenKey(userId: string): string {
  return `goofy:dmhidden:${userId}`;
}

export default function Sidebar(): ReactNode {
  const {
    user,
    profile,
    view,
    openFriends,
    openHub,
    dms,
    isOnline,
    getPerson,
    openDm,
    setSettingsOpen,
  } = useApp();
  const { snapshot, engine } = useCall();

  const me = user;
  const myName = profile?.displayName ?? me?.email?.split('@')[0] ?? 'goofy';
  const myColor = profile?.avatarColor ?? '#9ca3af';

  const visibleDms = dms.filter((dm) => {
    try {
      return window.localStorage.getItem(hiddenKey(me?.id ?? ''))?.includes(dm.userId) !== true;
    } catch {
      return true;
    }
  });

  const closeDm = (userId: string): void => {
    if (me === null) return;
    try {
      const key = hiddenKey(me.id);
      const raw = window.localStorage.getItem(key);
      const list: string[] = raw === null ? [] : (JSON.parse(raw) as string[]);
      if (!list.includes(userId)) list.push(userId);
      window.localStorage.setItem(key, JSON.stringify(list));
    } catch {
      // abaikan — fitur sembunyi hanya kenyamanan
    }
    if (view.kind === 'dm' && view.userId === userId) openFriends();
    // Paksa render ulang daftar.
    document.documentElement.dataset.dmTick = String(Date.now());
  };

  return (
    <div className="sidebar" role="complementary" aria-label="Daftar percakapan">
      <div className="sidebar__inner">
        <div className="sidebar__search">
          <button
            className="searchbtn"
            aria-label="Cari teman atau mulai percakapan"
            onClick={openFriends}
          >
            <Icon name="search" size={16} className="searchbtn__ic" />
            <span>Cari atau mulai percakapan</span>
          </button>
        </div>

        <nav className="sideitems" aria-label="Navigasi">
          <button
            className={`sideitem${view.kind === 'friends' ? ' is-active' : ''}`}
            onClick={openFriends}
            aria-current={view.kind === 'friends' ? 'page' : undefined}
          >
            <Icon name="friends" size={24} />
            <span className="sideitem__label">Teman</span>
          </button>
          <button
            className={`sideitem${view.kind === 'hub' ? ' is-active' : ''}`}
            onClick={openHub}
            aria-current={view.kind === 'hub' ? 'page' : undefined}
          >
            <Icon name="speaker" size={24} />
            <span className="sideitem__label">Room Suara</span>
            {snapshot.status !== 'idle' ? <span className="sideitem__live" aria-label="aktif">•</span> : null}
          </button>
        </nav>

        <div className="dmheader">
          <span>Pesan Langsung</span>
        </div>

        <div className="dmlist" role="list">
          {visibleDms.length === 0 ? (
            <p className="dmlist__empty">Belum ada percakapan — mulai dari daftar Teman.</p>
          ) : null}
          {visibleDms.map((dm) => {
            const person = getPerson(dm.userId);
            const active = view.kind === 'dm' && view.userId === dm.userId;
            const online = isOnline(dm.userId);
            const preview =
              dm.lastFromMe ? `Kamu: ${truncate(dm.lastBody, 24)}` : truncate(dm.lastBody, 28);
            return (
              <div
                key={dm.userId}
                className={`dm${active ? ' is-active' : ''}`}
                role="listitem"
                aria-current={active ? 'true' : undefined}
              >
                <button className="dm__open" onClick={() => openDm(dm.userId)} aria-label={`Buka percakapan dengan ${person?.displayName ?? 'pengguna'}`}>
                  <span className="avatar avatar--32">
                    <span
                      className="avatar__img"
                      style={{ ['--av-c' as string]: person?.avatarColor ?? '#757e8a' }}
                    >
                      {(person?.displayName ?? '?').slice(0, 1).toUpperCase()}
                    </span>
                    <span
                      className={`dot ${online ? 'dot--online' : 'dot--offline'}`}
                      title={online ? 'Online' : 'Offline'}
                    />
                  </span>
                  <span className="dm__body">
                    <span className="dm__row">
                      <span className="dm__name">{person?.displayName ?? 'pengguna'}</span>
                    </span>
                    <span className="dm__row">
                      <span className="dm__sub">{online ? 'aktif sekarang' : preview}</span>
                    </span>
                  </span>
                  {dm.unread > 0 ? (
                    <span className="badge" aria-label={`${String(dm.unread)} belum dibaca`}>
                      {dm.unread > 9 ? '9+' : dm.unread}
                    </span>
                  ) : null}
                </button>
                <button className="dm__close" aria-label="Sembunyikan percakapan" onClick={() => closeDm(dm.userId)}>
                  <Icon name="x" size={16} />
                </button>
              </div>
            );
          })}
        </div>

        <div className="userarea">
          <button
            className="userarea__id"
            aria-label="Buka pengaturan profil"
            title="Pengaturan profil"
            onClick={() => setSettingsOpen(true)}
          >
            <span className="avatar avatar--32">
              <span className="avatar__img" style={{ ['--av-c' as string]: myColor }}>
                {myName.slice(0, 1).toUpperCase()}
              </span>
              <span className="dot dot--online" title="Online" />
            </span>
            <span className="userarea__meta">
              <span className="userarea__name">{myName}</span>
              <span className="userarea__sub">
                {snapshot.status !== 'idle' ? 'di room suara' : 'online'}
              </span>
            </span>
          </button>
          <div className="userarea__actions">
            <button
              className={`iconbtn iconbtn--ua${snapshot.micMuted ? ' is-danger' : ''}`}
              aria-label={snapshot.micMuted ? 'Nyalakan mikrofon' : 'Bisukan mikrofon'}
              aria-pressed={snapshot.micMuted}
              title={snapshot.status === 'idle' ? 'Aktif saat panggilan' : snapshot.micAvailable ? (snapshot.micMuted ? 'Nyalakan mikrofon' : 'Bisukan mikrofon') : 'Mikrofon tidak tersedia — mode dengar-saja'}
              disabled={snapshot.status === 'idle' || !snapshot.micAvailable}
              onClick={() => engine.setMicMuted(!snapshot.micMuted)}
            >
              <Icon name={snapshot.micMuted ? 'micOff' : 'mic'} size={20} />
            </button>
            <button
              className={`iconbtn iconbtn--ua${snapshot.deafened ? ' is-danger' : ''}`}
              aria-label={snapshot.deafened ? 'Nyalakan audio' : 'Bisukan audio'}
              aria-pressed={snapshot.deafened}
              title={snapshot.status !== 'idle' ? (snapshot.deafened ? 'Nyalakan audio' : 'Bisukan audio') : 'Aktif saat panggilan'}
              disabled={snapshot.status === 'idle'}
              onClick={() => engine.setDeafened(!snapshot.deafened)}
            >
              <Icon name={snapshot.deafened ? 'headphonesOff' : 'headphones'} size={20} />
            </button>
            <button
              className="iconbtn iconbtn--ua"
              aria-label="Pengaturan"
              title="Pengaturan"
              onClick={() => setSettingsOpen(true)}
            >
              <Icon name="gear" size={20} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
