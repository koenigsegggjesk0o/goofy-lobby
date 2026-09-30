/**
 * Halaman Teman — tab Online/Semua/Menunggu/Tambah Teman.
 * "Tambah Teman" = pencarian profil berdasar nama tampilan + kirim/terima
 * permintaan pertemanan.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useApp } from '../state/store';
import { useCall } from '../state/call';
import { Icon } from '../lib/icons';
import type { FriendEntry, FriendRequestEntry } from '../../friends/types';
import type { Person } from '../state/store';

type Tab = 'online' | 'all' | 'pending' | 'add';

export default function FriendsView(): ReactNode {
  const store = useApp();
  const { friends, incoming, outgoing, isOnline } = store;
  const [tab, setTab] = useState<Tab>('online');

  const onlineFriends = useMemo(() => friends.filter((f) => isOnline(f.friendId)), [friends, isOnline]);
  const pendingCount = incoming.length + outgoing.length;

  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: 'online', label: 'Online', count: onlineFriends.length },
    { id: 'all', label: 'Semua', count: friends.length },
    { id: 'pending', label: 'Menunggu', count: pendingCount },
    { id: 'add', label: 'Tambah Teman' },
  ];

  return (
    <div className="friends">
      <header className="friends__header">
        <div className="friends__title">
          <Icon name="friends" size={24} />
          <h2>Teman</h2>
        </div>
        <div className="friends__tabs" role="tablist" aria-label="Filter teman">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`ftab${tab === t.id ? ' is-active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.count !== undefined && t.count > 0 ? <span className="ftab__count">{t.count}</span> : null}
              {t.id === 'pending' && incoming.length > 0 ? <span className="ftab__dot" aria-label="ada permintaan masuk" /> : null}
            </button>
          ))}
        </div>
      </header>

      <div className="friends__body">
        {tab === 'online' ? <FriendList entries={onlineFriends} emptyText="Tidak ada teman yang online — ajak seseorang!" /> : null}
        {tab === 'all' ? <FriendList entries={friends} emptyText="Belum punya teman — coba tab Tambah Teman" /> : null}
        {tab === 'pending' ? <PendingList /> : null}
        {tab === 'add' ? <AddFriend /> : null}
      </div>
    </div>
  );
}

function FriendRow({ entry }: { entry: FriendEntry }): ReactNode {
  const { openDm, openPopout, isOnline, removeFriendEntry } = useApp();
  const { startOutgoing, snapshot } = useCall();
  const busy = useRef(false);
  const p = entry.profile;
  const online = isOnline(p.id);

  return (
    <div className="frow" role="listitem">
      <button
        className="frow__id"
        onClick={(e) => openPopout(p, e.clientX, e.clientY)}
        aria-label={`Buka profil ${p.displayName}`}
      >
        <span className="avatar avatar--32">
          <span className="avatar__img" style={{ ['--av-c' as string]: p.avatarColor }}>
            {p.displayName.slice(0, 1).toUpperCase()}
          </span>
          <span className={`dot ${online ? 'dot--online' : 'dot--offline'}`} title={online ? 'Online' : 'Offline'} />
        </span>
        <span className="frow__meta">
          <span className="frow__name">{p.displayName}</span>
          <span className="frow__sub">{online ? 'aktif sekarang' : 'offline'}</span>
        </span>
      </button>
      <div className="frow__actions">
        <button
          className="iconbtn frow__act"
          aria-label={`Kirim pesan ke ${p.displayName}`}
          title="Kirim pesan"
          onClick={() => openDm(p.id)}
        >
          <Icon name="hash" size={20} />
        </button>
        <button
          className="iconbtn frow__act"
          aria-label={`Telepon ${p.displayName}`}
          title="Telepon (suara spasial)"
          disabled={snapshot.status !== 'idle'}
          onClick={() => {
            if (busy.current) return;
            busy.current = true;
            void startOutgoing(p).finally(() => {
              busy.current = false;
            });
          }}
        >
          <Icon name="phone" size={20} />
        </button>
        <button
          className="iconbtn frow__act frow__act--danger"
          aria-label={`Hapus ${p.displayName} dari teman`}
          title="Hapus teman"
          onClick={() => {
            if (window.confirm(`Hapus ${p.displayName} dari teman?`)) void removeFriendEntry(entry);
          }}
        >
          <Icon name="trash" size={20} />
        </button>
      </div>
    </div>
  );
}

function FriendList({ entries, emptyText }: { entries: FriendEntry[]; emptyText: string }): ReactNode {
  if (entries.length === 0) {
    return <p className="friends__empty">{emptyText}</p>;
  }
  return (
    <div className="friends__list" role="list">
      {entries.map((entry) => (
        <FriendRow key={entry.friendshipId} entry={entry} />
      ))}
    </div>
  );
}

function PendingList(): ReactNode {
  const { incoming, outgoing, acceptRequest, declineRequest, cancelRequest } = useApp();

  return (
    <div className="friends__pending">
      {incoming.length === 0 && outgoing.length === 0 ? (
        <p className="friends__empty">Tidak ada permintaan menunggu.</p>
      ) : null}
      {incoming.length > 0 ? (
        <>
          <p className="friends__section">Permintaan masuk — {String(incoming.length)}</p>
          <div className="friends__list" role="list">
            {incoming.map((entry) => (
              <RequestRow
                key={entry.friendshipId}
                entry={entry}
                primaryLabel="Terima"
                secondaryLabel="Tolak"
                onPrimary={() => void acceptRequest(entry)}
                onSecondary={() => void declineRequest(entry)}
                primaryIcon="check"
                secondaryIcon="x"
              />
            ))}
          </div>
        </>
      ) : null}
      {outgoing.length > 0 ? (
        <>
          <p className="friends__section">Permintaan terkirim — {String(outgoing.length)}</p>
          <div className="friends__list" role="list">
            {outgoing.map((entry) => (
              <RequestRow
                key={entry.friendshipId}
                entry={entry}
                primaryLabel="Batalkan"
                secondaryLabel={undefined}
                onPrimary={() => void cancelRequest(entry)}
                onSecondary={undefined}
                primaryIcon="x"
                secondaryIcon={undefined}
              />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function RequestRow({
  entry,
  primaryLabel,
  secondaryLabel,
  onPrimary,
  onSecondary,
  primaryIcon,
  secondaryIcon,
}: {
  entry: FriendRequestEntry;
  primaryLabel: string;
  secondaryLabel?: string;
  onPrimary: () => void;
  onSecondary?: () => void;
  primaryIcon: 'check' | 'x';
  secondaryIcon?: 'check' | 'x';
}): ReactNode {
  const p = entry.profile;
  return (
    <div className="frow frow--pending" role="listitem">
      <div className="frow__id">
        <span className="avatar avatar--32">
          <span className="avatar__img" style={{ ['--av-c' as string]: p.avatarColor }}>
            {p.displayName.slice(0, 1).toUpperCase()}
          </span>
          <span className="dot dot--offline" title="Menunggu" />
        </span>
        <span className="frow__meta">
          <span className="frow__name">{p.displayName}</span>
          <span className="frow__sub">menunggu persetujuan</span>
        </span>
      </div>
      <div className="frow__actions">
        <button
          className="btn btn--primary btn--sm"
          onClick={onPrimary}
          aria-label={`${primaryLabel} permintaan ${p.displayName}`}
        >
          {primaryIcon === 'check' ? <Icon name="check" size={16} /> : <Icon name="x" size={16} />}
          {primaryLabel}
        </button>
        {secondaryLabel !== undefined && onSecondary !== undefined ? (
          <button
            className="btn btn--ghost btn--sm"
            onClick={onSecondary}
            aria-label={`${secondaryLabel} permintaan ${p.displayName}`}
          >
            {secondaryIcon === 'x' ? <Icon name="x" size={16} /> : null}
            {secondaryLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function AddFriend(): ReactNode {
  const { searchProfiles, friends, incoming, outgoing, addFriend, acceptRequest, user } = useApp();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Person[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [sentTo, setSentTo] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (q.trim().length < 2) {
      setResults([]);
      setSearched(false);
      return;
    }
    setSearching(true);
    const t = window.setTimeout(() => {
      void searchProfiles(q)
        .then((found) => {
          setResults(found);
          setSearched(true);
        })
        .finally(() => setSearching(false));
    }, 350);
    return () => window.clearTimeout(t);
  }, [q, searchProfiles]);

  const stateOf = (person: Person): { label: string; action: (() => void) | null; tone: 'ok' | 'muted' | 'primary' } => {
    if (friends.some((f) => f.friendId === person.id)) return { label: 'Sudah teman', action: null, tone: 'ok' };
    const out = outgoing.find((r) => r.addresseeId === person.id);
    if (out !== undefined) return { label: 'Menunggu jawaban', action: null, tone: 'muted' };
    const inc = incoming.find((r) => r.requesterId === person.id);
    if (inc !== undefined)
      return {
        label: 'Terima permintaan',
        action: () => void acceptRequest(inc),
        tone: 'primary',
      };
    if (sentTo.has(person.id)) return { label: 'Terkirim ✓', action: null, tone: 'muted' };
    return {
      label: 'Kirim permintaan',
      action: () => {
        setSentTo((prev) => new Set(prev).add(person.id));
        void addFriend(person);
      },
      tone: 'primary',
    };
  };

  return (
    <div className="addfriend">
      <h3 className="addfriend__title">TAMBAH TEMAN</h3>
      <p className="addfriend__hint">
        Cari orang berdasarkan nama tampilan{user?.email !== undefined ? '' : ''} — lalu kirim permintaan.
      </p>
      <div className="addfriend__bar">
        <Icon name="search" size={20} />
        <input
          className="addfriend__input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Ketik nama — mis. Alya"
          aria-label="Cari profil berdasarkan nama tampilan"
          maxLength={32}
        />
        {searching ? <span className="spinner spinner--sm" aria-hidden="true" /> : null}
      </div>

      <div className="addfriend__results" role="list">
        {results.map((person) => {
          const state = stateOf(person);
          return (
            <div key={person.id} className="frow" role="listitem">
              <div className="frow__id">
                <span className="avatar avatar--32">
                  <span className="avatar__img" style={{ ['--av-c' as string]: person.avatarColor }}>
                    {person.displayName.slice(0, 1).toUpperCase()}
                  </span>
                </span>
                <span className="frow__meta">
                  <span className="frow__name">{person.displayName}</span>
                  <span className="frow__sub">goofy user</span>
                </span>
              </div>
              <div className="frow__actions">
                {state.action !== null ? (
                  <button
                    className={`btn btn--sm ${state.tone === 'primary' ? 'btn--primary' : 'btn--ghost'}`}
                    onClick={state.action}
                  >
                    <Icon name="userPlus" size={16} />
                    {state.label}
                  </button>
                ) : (
                  <span className={`frow__state frow__state--${state.tone}`}>{state.label}</span>
                )}
              </div>
            </div>
          );
        })}
        {searched && !searching && results.length === 0 ? (
          <p className="friends__empty">
            Tidak ada profil bernama “{q}”. Pastikan teman sudah daftar, lalu cari nama tampilannya.
          </p>
        ) : null}
      </div>
    </div>
  );
}
