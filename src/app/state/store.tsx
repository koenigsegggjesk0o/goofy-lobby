/**
 * Store aplikasi (React context) — sesi, profil, teman, permintaan,
 * presence online, ringkasan DM + unread, dan notifikasi "poke" realtime.
 *
 * Strategi data: fetch PostgREST tervalidasi (services) + sinyal segar via
 * channel broadcast "goofy:pokes" (payload TANPA konten — hanya {to, kind})
 * + polling lambat 10 detik sebagai fallback. Payload poke memang tanpa isi
 * supaya channel publik tidak pernah membocorkan data.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { RealtimeChannel, User } from '@supabase/supabase-js';
import { sb, friendsSvc, messagesSvc, profilesSvc } from '../lib/services';
import type { FriendEntry, FriendRequestEntry } from '../../friends/types';
import { FriendshipProfileSummarySchema } from '../../friends/types';
import type { Profile } from '../../profile/types';
import { useToast } from './toast';

export interface Person {
  id: string;
  displayName: string;
  avatarColor: string;
}

export interface DmSummary {
  userId: string;
  lastBody: string;
  lastAt: string;
  lastFromMe: boolean;
  unread: number;
}

export type MainView = { kind: 'friends' } | { kind: 'dm'; userId: string } | { kind: 'hub' };

interface AppCtx {
  ready: boolean;
  user: User | null;
  profile: Profile | null;
  people: ReadonlyMap<string, Person>;
  friends: FriendEntry[];
  incoming: FriendRequestEntry[];
  outgoing: FriendRequestEntry[];
  dms: DmSummary[];
  presence: ReadonlySet<string>;
  /** Naik setiap ada sinyal data DM baru — dipakai ChatView utk refetch. */
  dmVersion: number;
  rail: 'home' | 'hub';
  view: MainView;
  settingsOpen: boolean;
  popout: { person: Person; x: number; y: number } | null;
  isOnline: (userId: string) => boolean;
  getPerson: (userId: string) => Person | null;
  openFriends(): void;
  openDm(userId: string): void;
  openHub(): void;
  setSettingsOpen(open: boolean): void;
  openPopout(person: Person, x: number, y: number): void;
  closePopout(): void;
  refreshSocial(): Promise<void>;
  refreshDms(): Promise<void>;
  markRead(userId: string): void;
  sendPoke(to: string, kind: 'dm' | 'friends'): void;
  searchProfiles(q: string): Promise<Person[]>;
  addFriend(person: Person): Promise<void>;
  acceptRequest(entry: FriendRequestEntry): Promise<void>;
  declineRequest(entry: FriendRequestEntry): Promise<void>;
  cancelRequest(entry: FriendRequestEntry): Promise<void>;
  removeFriendEntry(entry: FriendEntry): Promise<void>;
  saveProfile(patch: { displayName?: string; avatarColor?: string }): Promise<void>;
  logout(): Promise<void>;
}

const Ctx = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const ctx = useContext(Ctx);
  if (ctx === null) throw new Error('useApp harus di dalam AppProvider');
  return ctx;
}

function readStampKey(userId: string): string {
  return `goofy:read:${userId}`;
}

function loadReadMap(userId: string): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(readStampKey(userId));
    return raw === null ? {} : (JSON.parse(raw) as Record<string, string>);
  } catch {
    return {};
  }
}

function saveReadMap(userId: string, map: Record<string, string>): void {
  try {
    window.localStorage.setItem(readStampKey(userId), JSON.stringify(map));
  } catch {
    // localStorage penuh/di-blok — unread hanya tidak persist antar sesi.
  }
}

interface RawMessageRow {
  id: string;
  sender_id: string;
  recipient_id: string;
  body: string;
  created_at: string;
}

export function AppProvider({ children }: { children: ReactNode }): ReactNode {
  const { toast } = useToast();
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [friends, setFriends] = useState<FriendEntry[]>([]);
  const [incoming, setIncoming] = useState<FriendRequestEntry[]>([]);
  const [outgoing, setOutgoing] = useState<FriendRequestEntry[]>([]);
  const [dms, setDms] = useState<DmSummary[]>([]);
  const [presence, setPresence] = useState<ReadonlySet<string>>(new Set());
  const [people, setPeople] = useState<ReadonlyMap<string, Person>>(new Map());
  const [dmVersion, setDmVersion] = useState(0);
  const [rail, setRail] = useState<'home' | 'hub'>('home');
  const [view, setView] = useState<MainView>({ kind: 'friends' });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [popout, setPopout] = useState<AppCtx['popout']>(null);

  const pokeChannel = useRef<RealtimeChannel | null>(null);
  const readMap = useRef<Record<string, string>>({});
  const openDmRef = useRef<string | null>(null);
  openDmRef.current = view.kind === 'dm' ? view.userId : null;
  // Mirror people untuk pembacaan async tanpa side-effect di dalam setState.
  const peopleRef = useRef<ReadonlyMap<string, Person>>(new Map());
  peopleRef.current = people;

  // ── Auth lifecycle ─────────────────────────────────────────────────
  useEffect(() => {
    const client = sb();
    let alive = true;
    client
      .auth.getSession()
      .then(({ data }) => {
        if (!alive) return;
        setUser(data.session?.user ?? null);
        setReady(true);
      })
      .catch(() => {
        if (alive) setReady(true);
      });
    const { data: sub } = client.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setReady(true);
    });
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const mergePeople = useCallback((entries: Person[]) => {
    setPeople((prev) => {
      const next = new Map(prev);
      for (const p of entries) next.set(p.id, p);
      return next;
    });
  }, []);

  // ── Refresh: teman + permintaan ────────────────────────────────────
  const refreshSocial = useCallback(async () => {
    const me = user;
    if (me === null) return;
    try {
      const [friendList, incomingList, outgoingList] = await Promise.all([
        friendsSvc().listFriends(me.id),
        friendsSvc().listIncomingRequests(me.id),
        friendsSvc().listOutgoingRequests(me.id),
      ]);
      setFriends(friendList);
      setIncoming(incomingList);
      setOutgoing(outgoingList);
      mergePeople([
        ...friendList.map((f) => f.profile),
        ...incomingList.map((r) => r.profile),
        ...outgoingList.map((r) => r.profile),
      ]);
    } catch (error) {
      console.warn('[goofy] refreshSocial gagal:', error);
    }
  }, [user, mergePeople]);

  // ── Refresh: ringkasan DM + unread ─────────────────────────────────
  const refreshDms = useCallback(async () => {
    const me = user;
    if (me === null) return;
    const { data, error } = await sb()
      .from('messages')
      .select('id,sender_id,recipient_id,body,created_at')
      .or(`sender_id.eq.${me.id},recipient_id.eq.${me.id}`)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error !== null) {
      console.warn('[goofy] refreshDms gagal:', error.message);
      return;
    }
    const rows = (Array.isArray(data) ? data : []) as RawMessageRow[];
    const openPartner = openDmRef.current;
    const read = loadReadMap(me.id);
    const lastByPartner = new Map<string, DmSummary>();
    const unreadByPartner = new Map<string, number>();
    for (const row of rows) {
      const partner = row.sender_id === me.id ? row.recipient_id : row.sender_id;
      const fromMe = row.sender_id === me.id;
      if (!lastByPartner.has(partner)) {
        lastByPartner.set(partner, {
          userId: partner,
          lastBody: row.body,
          lastAt: row.created_at,
          lastFromMe: fromMe,
          unread: 0,
        });
      }
      if (!fromMe && partner !== openPartner) {
        const stamp = read[partner];
        if (stamp === undefined || row.created_at > stamp) {
          unreadByPartner.set(partner, (unreadByPartner.get(partner) ?? 0) + 1);
        }
      }
    }
    // DM yang sedang terbuka → langsung tandai terbaca.
    if (openPartner !== null) {
      read[openPartner] = new Date().toISOString();
      saveReadMap(me.id, read);
    }
    const summaries = [...lastByPartner.values()].map((s) => ({
      ...s,
      unread: unreadByPartner.get(s.userId) ?? 0,
    }));
    summaries.sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
    setDms(summaries);
    setDmVersion((v) => v + 1);

    // Lengkapi profil partner yang bukan teman lagi (batch, tervalidasi).
    const known = peopleRef.current;
    const missing = [...lastByPartner.keys()].filter((id) => !known.has(id));
    if (missing.length > 0) {
      const { data: profileRows } = await sb()
        .from('profiles')
        .select('id,display_name,avatar_color')
        .in('id', missing);
      const parsed: Person[] = [];
      for (const raw of Array.isArray(profileRows) ? profileRows : []) {
        const res = FriendshipProfileSummarySchema.safeParse(raw);
        if (res.success) {
          parsed.push({
            id: res.data.id,
            displayName: res.data.display_name,
            avatarColor: res.data.avatar_color,
          });
        }
      }
      if (parsed.length > 0) mergePeople(parsed);
    }
  }, [user, mergePeople]);

  const refreshRef = useRef({ social: refreshSocial, dms: refreshDms });
  refreshRef.current = { social: refreshSocial, dms: refreshDms };

  const markRead = useCallback(
    (userId: string) => {
      const me = user;
      if (me === null) return;
      const read = loadReadMap(me.id);
      read[userId] = new Date().toISOString();
      saveReadMap(me.id, read);
      // Bail-out referensi-sama: tanpa perubahan unread JANGAN buat array baru —
      // array baru di sini memicu effect [dms] → markRead → loop tak berujung.
      setDms((prev) => {
        const target = prev.find((d) => d.userId === userId);
        if (target === undefined || target.unread === 0) return prev;
        return prev.map((d) => (d.userId === userId ? { ...d, unread: 0 } : d));
      });
    },
    [user],
  );

  const sendPoke = useCallback((to: string, kind: 'dm' | 'friends') => {
    void pokeChannel.current?.send({
      type: 'broadcast',
      event: 'p',
      payload: { to, kind },
    });
  }, []);

  // ── Channel presence + poke + poll (hidup selama login) ───────────
  useEffect(() => {
    const me = user;
    if (me === null) {
      setFriends([]);
      setIncoming([]);
      setOutgoing([]);
      setDms([]);
      setPresence(new Set());
      setProfile(null);
      setPeople(new Map());
      setView({ kind: 'friends' });
      setRail('home');
      return;
    }
    readMap.current = loadReadMap(me.id);

    // Profil sendiri — retry sekali (race trigger pasca-signup).
    let cancelled = false;
    const loadProfile = async (retries: number): Promise<void> => {
      try {
        const own = await profilesSvc().getProfile(me.id);
        if (!cancelled && own !== null) setProfile(own);
      } catch (error) {
        console.warn('[goofy] loadProfile gagal:', error);
        if (retries > 0) {
          await new Promise((r) => window.setTimeout(r, 1500));
          if (!cancelled) await loadProfile(retries - 1);
        }
      }
    };
    void loadProfile(2);

    // Presence global — key presence = userId (indikator online). Channel
    // PRIVATE + policy 0022: hanya authenticated (private_only cloud ON).
    const presenceCh = sb().channel('goofy:presence', {
      config: { presence: { key: me.id }, private: true },
    });
    presenceCh.on('presence', { event: 'sync' }, () => {
      setPresence(new Set(Object.keys(presenceCh.presenceState())));
    });
    void presenceCh.subscribe(async (status, err) => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.warn('[goofy] presence channel gagal:', status, err);
        return;
      }
      if (status === 'SUBSCRIBED') {
        await presenceCh.track({ at: Date.now() });
        void refreshRef.current.social();
        void refreshRef.current.dms();
      }
    });

    // Bus poke publik — payload tanpa konten, difilter per penerima.
    const poke = sb().channel('goofy:pokes', { config: { private: true } });
    poke.on('broadcast', { event: 'p' }, (message) => {
      const payload = message.payload as { to?: string; kind?: string } | null;
      if (payload?.to !== me.id) return;
      if (payload.kind === 'friends') void refreshRef.current.social();
      void refreshRef.current.dms();
    });
    void poke.subscribe((status, err) => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.warn('[goofy] poke channel gagal:', status, err);
      }
    });
    pokeChannel.current = poke;

    const poll = window.setInterval(() => {
      void refreshRef.current.social();
      void refreshRef.current.dms();
    }, 10_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void refreshRef.current.social();
        void refreshRef.current.dms();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(poll);
      pokeChannel.current = null;
      void sb().removeChannel(poke);
      void sb().removeChannel(presenceCh);
    };
  }, [user]);

  // ── Aksi teman ─────────────────────────────────────────────────────
  const addFriend = useCallback(
    async (person: Person) => {
      const me = user;
      if (me === null) return;
      try {
        await friendsSvc().sendFriendRequest(me.id, person.id);
        toast(`Permintaan terkirim ke ${person.displayName}`, 'success');
      } catch (error) {
        toast(describeFriendError(error, person.displayName), 'error');
      }
      await refreshSocial();
      sendPoke(person.id, 'friends');
    },
    [user, toast, refreshSocial, sendPoke],
  );

  const acceptRequest = useCallback(
    async (entry: FriendRequestEntry) => {
      const me = user;
      if (me === null) return;
      try {
        await friendsSvc().acceptFriendRequest(me.id, entry.friendshipId);
        toast(`Kamu sekarang berteman dengan ${entry.profile.displayName}`, 'success');
      } catch (error) {
        toast(describeFriendError(error, entry.profile.displayName), 'error');
      }
      await refreshSocial();
      sendPoke(entry.requesterId, 'friends');
    },
    [user, toast, refreshSocial, sendPoke],
  );

  const declineRequest = useCallback(
    async (entry: FriendRequestEntry) => {
      const me = user;
      if (me === null) return;
      try {
        await friendsSvc().declineFriendRequest(me.id, entry.friendshipId);
      } catch (error) {
        toast(describeFriendError(error, entry.profile.displayName), 'error');
      }
      await refreshSocial();
    },
    [user, toast, refreshSocial],
  );

  const cancelRequest = useCallback(
    async (entry: FriendRequestEntry) => {
      const me = user;
      if (me === null) return;
      try {
        await friendsSvc().cancelFriendRequest(me.id, entry.friendshipId);
      } catch (error) {
        toast(describeFriendError(error, entry.profile.displayName), 'error');
      }
      await refreshSocial();
      sendPoke(entry.addresseeId, 'friends');
    },
    [user, toast, refreshSocial, sendPoke],
  );

  const removeFriendEntry = useCallback(
    async (entry: FriendEntry) => {
      const me = user;
      if (me === null) return;
      try {
        await friendsSvc().removeFriend(me.id, entry.friendshipId);
        toast(`${entry.profile.displayName} dihapus dari teman`, 'info');
      } catch (error) {
        toast(describeFriendError(error, entry.profile.displayName), 'error');
      }
      await refreshSocial();
      sendPoke(entry.friendId, 'friends');
    },
    [user, toast, refreshSocial, sendPoke],
  );

  // ── Cari profil (nama tampilan) ────────────────────────────────────
  const searchProfiles = useCallback(
    async (q: string): Promise<Person[]> => {
      const me = user;
      if (me === null || q.trim().length < 2) return [];
      const cleaned = q.trim().replace(/[%_\\]/g, '');
      if (cleaned.length < 2) return [];
      const { data, error } = await sb()
        .from('profiles')
        .select('id,display_name,avatar_color')
        .ilike('display_name', `%${cleaned}%`)
        .neq('id', me.id)
        .limit(12);
      if (error !== null) {
        console.warn('[goofy] searchProfiles gagal:', error.message);
        return [];
      }
      const parsed: Person[] = [];
      for (const raw of Array.isArray(data) ? data : []) {
        const res = FriendshipProfileSummarySchema.safeParse(raw);
        if (res.success) {
          parsed.push({
            id: res.data.id,
            displayName: res.data.display_name,
            avatarColor: res.data.avatar_color,
          });
        }
      }
      mergePeople(parsed);
      return parsed;
    },
    [user, mergePeople],
  );

  const saveProfile = useCallback(
    async (patch: { displayName?: string; avatarColor?: string }) => {
      const me = user;
      if (me === null) return;
      try {
        const updated = await profilesSvc().updateProfile(me.id, patch);
        setProfile(updated);
        toast('Profil tersimpan', 'success');
      } catch (error) {
        toast(error instanceof Error ? error.message : 'gagal menyimpan profil', 'error');
      }
    },
    [user, toast],
  );

  const logout = useCallback(async () => {
    await sb().auth.signOut();
    toast('Kamu keluar dari goofy', 'info');
  }, [toast]);

  // ── Navigasi ───────────────────────────────────────────────────────
  const openFriends = useCallback(() => {
    setRail('home');
    setView({ kind: 'friends' });
  }, []);
  const openDm = useCallback(
    (userId: string) => {
      setRail('home');
      setView({ kind: 'dm', userId });
      markRead(userId);
      void refreshRef.current.dms();
    },
    [markRead],
  );
  const openHub = useCallback(() => {
    setRail('hub');
    setView({ kind: 'hub' });
  }, []);

  const isOnline = useCallback((userId: string) => presence.has(userId), [presence]);
  const getPerson = useCallback((userId: string) => people.get(userId) ?? null, [people]);

  const value = useMemo<AppCtx>(
    () => ({
      ready,
      user,
      profile,
      people,
      friends,
      incoming,
      outgoing,
      dms,
      presence,
      dmVersion,
      rail,
      view,
      settingsOpen,
      popout,
      isOnline,
      getPerson,
      openFriends,
      openDm,
      openHub,
      setSettingsOpen,
      openPopout: (person, x, y) => setPopout({ person, x, y }),
      closePopout: () => setPopout(null),
      refreshSocial,
      refreshDms,
      markRead,
      sendPoke,
      searchProfiles,
      addFriend,
      acceptRequest,
      declineRequest,
      cancelRequest,
      removeFriendEntry,
      saveProfile,
      logout,
    }),
    [
      ready,
      user,
      profile,
      people,
      friends,
      incoming,
      outgoing,
      dms,
      presence,
      dmVersion,
      rail,
      view,
      settingsOpen,
      popout,
      isOnline,
      getPerson,
      openFriends,
      openDm,
      openHub,
      refreshSocial,
      refreshDms,
      markRead,
      sendPoke,
      searchProfiles,
      addFriend,
      acceptRequest,
      declineRequest,
      cancelRequest,
      removeFriendEntry,
      saveProfile,
      logout,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Pesan ramah per kode FriendsError. */
function describeFriendError(error: unknown, name: string): string {
  const code = (error as { code?: string }).code;
  switch (code) {
    case 'already-friends':
      return `Kamu sudah berteman dengan ${name}`;
    case 'request-exists':
      return `Permintaan dengan ${name} sudah ada — cek tab Menunggu`;
    case 'rate-limited':
      return 'Terlalu banyak permintaan teman dalam 1 jam — coba lagi nanti';
    case 'blocked':
      return 'Tidak bisa mengirim permintaan (ada blokir)';
    case 'self-request':
      return 'Tidak bisa menambah diri sendiri';
    case 'not-found':
      return 'Data pertemanan tidak ditemukan — muat ulang';
    default:
      return error instanceof Error ? error.message : 'Terjadi kesalahan';
  }
}

// Dipakai ChatView lewat messagesSvc — re-export supaya impor tetap satu pintu.
export { messagesSvc };
