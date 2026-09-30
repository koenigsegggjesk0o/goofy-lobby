/**
 * CallProvider — jembatan React untuk CallEngine + siklus protokol undangan
 * DM ([goofy-call]/[goofy-declined]/[goofy-end]) + panggilan masuk.
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
import { useApp, type Person } from './store';
import { messagesSvc } from '../lib/services';
import {
  INVITE_FRESH_MS,
  callDeclinedBody,
  callEndBody,
  callInviteBody,
  parseCallDeclined,
  parseCallEnd,
  parseCallInvite,
} from '../lib/protocol';
import { CallEngine, type CallSnapshot } from './callEngine';
import { useToast } from './toast';

export interface IncomingCall {
  code: string;
  from: Person;
  at: number;
}

interface CallCtx {
  engine: CallEngine;
  snapshot: CallSnapshot;
  incoming: IncomingCall | null;
  /** Lawan bicara untuk DM call (null utk room hub). */
  target: Person | null;
  /** Peran sesi panggilan ini — menentukan teks wajah "menunggu". */
  role: 'caller' | 'callee' | 'hub';
  startOutgoing(person: Person): Promise<void>;
  acceptIncoming(): Promise<void>;
  declineIncoming(): Promise<void>;
  joinByCode(code: string): Promise<void>;
  leaveCall(): Promise<void>;
}

const Ctx = createContext<CallCtx | null>(null);

export function useCall(): CallCtx {
  const ctx = useContext(Ctx);
  if (ctx === null) throw new Error('useCall harus di dalam CallProvider');
  return ctx;
}

export function CallProvider({ children }: { children: ReactNode }): ReactNode {
  const store = useApp();
  const { toast } = useToast();
  const engineRef = useRef<CallEngine | null>(null);
  if (engineRef.current === null) engineRef.current = new CallEngine();
  const engine = engineRef.current;

  const [snapshot, setSnapshot] = useState<CallSnapshot>(() => engine.snapshot);
  const [incoming, setIncoming] = useState<IncomingCall | null>(null);
  const [target, setTarget] = useState<Person | null>(null);
  const [role, setRole] = useState<'caller' | 'callee' | 'hub'>('caller');
  const handledCodes = useRef<Set<string>>(new Set());
  const noAnswerTimer = useRef<number | null>(null);
  const autoLeaveTimer = useRef<number | null>(null);
  const lastErrorRef = useRef<string | null>(null);
  // Ref mirror supaya callback stabil tidak menangkap state basi.
  const targetRef = useRef<Person | null>(null);
  targetRef.current = target;
  const storeRef = useRef(store);
  storeRef.current = store;

  useEffect(() => engine.subscribe(() => setSnapshot(engine.snapshot)), [engine]);

  // ── Deteksi undangan masuk dari ringkasan DM terbaru ──────────────
  useEffect(() => {
    if (store.user === null) return;
    for (const dm of store.dms) {
      if (dm.lastFromMe) continue;
      const code = parseCallInvite(dm.lastBody);
      if (code === null || handledCodes.current.has(code)) continue;
      if (Date.now() - new Date(dm.lastAt).getTime() > INVITE_FRESH_MS) continue;
      const from = store.getPerson(dm.userId);
      if (from === null) continue;
      handledCodes.current.add(code);
      if (engine.snapshot.status !== 'idle') continue; // sedang call — kartu undigan tetap ada di chat
      setIncoming({ code, from, at: Date.now() });
      break;
    }
  }, [store.dmVersion, store.dms, store.getPerson, store.user, engine]);

  // Bunyi dering masuk hangus setelah 40 detik.
  useEffect(() => {
    if (incoming === null) return;
    const t = window.setTimeout(() => setIncoming(null), 40_000);
    return () => window.clearTimeout(t);
  }, [incoming]);

  // ── Notifikasi error engine (sekali per pesan) ─────────────────────
  useEffect(() => {
    if (snapshot.error !== null && snapshot.error !== lastErrorRef.current) {
      lastErrorRef.current = snapshot.error;
      toast(snapshot.error, 'error');
    }
    if (snapshot.error === null) lastErrorRef.current = null;
  }, [snapshot.error, toast]);

  // ── Ditolak / ditutup lawan → akhiri overlay ───────────────────────
  useEffect(() => {
    if (target === null || snapshot.code === null) return;
    for (const dm of store.dms) {
      if (dm.userId !== target.id || dm.lastFromMe) continue;
      if (parseCallDeclined(dm.lastBody) === snapshot.code) {
        handledCodes.current.add(dm.lastBody);
        toast(`${target.displayName} menolak panggilan`, 'info');
        void engine.leave();
        setTarget(null);
        return;
      }
      if (parseCallEnd(dm.lastBody) === snapshot.code) {
        handledCodes.current.add(dm.lastBody);
        toast('Panggilan ditutup', 'info');
        void engine.leave();
        setTarget(null);
        return;
      }
    }
  }, [store.dmVersion, store.dms, target, snapshot.code, engine, toast]);

  // ── Semua peer pergi → auto-leave setelah jeda 8 detik ─────────────
  useEffect(() => {
    if (snapshot.status !== 'active' || snapshot.peers.length > 0) {
      if (autoLeaveTimer.current !== null) {
        window.clearTimeout(autoLeaveTimer.current);
        autoLeaveTimer.current = null;
      }
      return;
    }
    if (autoLeaveTimer.current !== null) return;
    autoLeaveTimer.current = window.setTimeout(() => {
      autoLeaveTimer.current = null;
      if (engine.snapshot.status === 'active' && engine.snapshot.peers.length === 0) {
        toast('Semua peserta keluar — room ditutup', 'info');
        void engine.leave();
        setTarget(null);
      }
    }, 8_000);
    return () => {
      if (autoLeaveTimer.current !== null) {
        window.clearTimeout(autoLeaveTimer.current);
        autoLeaveTimer.current = null;
      }
    };
  }, [snapshot.status, snapshot.peers.length, engine, toast]);

  // ── Logout / sesi hilang → tinggalkan room ─────────────────────────
  useEffect(() => {
    if (store.user === null && engine.snapshot.status !== 'idle') void engine.leave();
  }, [store.user, engine]);

  const clearNoAnswer = (): void => {
    if (noAnswerTimer.current !== null) {
      window.clearTimeout(noAnswerTimer.current);
      noAnswerTimer.current = null;
    }
  };

  const selfSession = useCallback(() => {
    const me = store.user;
    const profile = store.profile;
    if (me === null) throw new Error('belum masuk');
    return {
      sessionId: `u-${crypto.randomUUID().slice(0, 12)}`,
      userId: me.id,
      displayName: profile?.displayName ?? 'goofy user',
      avatarColor: profile?.avatarColor ?? '#9ca3af',
    };
  }, [store.user, store.profile]);

  const leaveCallInternal = useCallback(
    async (code: string | null): Promise<void> => {
      clearNoAnswer();
      const me = storeRef.current.user;
      const partner = targetRef.current;
      await engine.leave();
      setTarget(null);
      if (me !== null && partner !== null && code !== null) {
        try {
          await messagesSvc().sendMessage(me.id, partner.id, callEndBody(code));
          storeRef.current.sendPoke(partner.id, 'dm');
        } catch {
          // best-effort — lawan tetap dapat cleanup via timeout sendiri
        }
      }
    },
    [engine],
  );

  const startOutgoing = useCallback(
    async (person: Person) => {
      const me = storeRef.current.user;
      if (me === null) return;
      if (engine.snapshot.status !== 'idle') {
        toast('Masih ada panggilan aktif — tutup dulu', 'error');
        return;
      }
      setTarget(person);
      setRole('caller');
      try {
        await engine.start({ mode: 'create', self: selfSession() });
        const code = engine.snapshot.code;
        if (code === null) throw new Error('kode room tidak terbit');
        await messagesSvc().sendMessage(me.id, person.id, callInviteBody(code));
        storeRef.current.sendPoke(person.id, 'dm');
        clearNoAnswer();
        noAnswerTimer.current = window.setTimeout(() => {
          if (engine.snapshot.status === 'ringing') {
            toast(`${person.displayName} tidak menjawab`, 'info');
            void leaveCallInternal(code);
          }
        }, 45_000);
      } catch (error) {
        setTarget(null);
        clearNoAnswer();
        toast(error instanceof Error ? error.message : 'gagal memulai panggilan', 'error');
      }
    },
    [engine, toast, selfSession, leaveCallInternal],
  );

  const acceptIncoming = useCallback(async () => {
    const call = incoming;
    if (call === null) return;
    setIncoming(null);
    setTarget(call.from);
    setRole('callee');
    try {
      await engine.start({ mode: 'join', code: call.code, self: selfSession() });
    } catch (error) {
      setTarget(null);
      toast(error instanceof Error ? error.message : 'gagal bergabung panggilan', 'error');
    }
  }, [incoming, engine, selfSession, toast]);

  const declineIncoming = useCallback(async () => {
    const call = incoming;
    if (call === null) return;
    setIncoming(null);
    const me = store.user;
    if (me === null) return;
    try {
      await messagesSvc().sendMessage(me.id, call.from.id, callDeclinedBody(call.code));
      store.sendPoke(call.from.id, 'dm');
    } catch {
      // best-effort
    }
  }, [incoming, store, toast]);

  const joinByCode = useCallback(
    async (code: string) => {
      if (engine.snapshot.status !== 'idle') {
        toast('Masih ada panggilan aktif — tutup dulu', 'error');
        return;
      }
      setTarget(null);
      setRole('hub');
      try {
        await engine.start({ mode: 'join', code, self: selfSession() });
      } catch (error) {
        toast(error instanceof Error ? error.message : 'gagal bergabung room', 'error');
      }
    },
    [engine, selfSession, toast],
  );

  const leaveCall = useCallback(async () => {
    await leaveCallInternal(engine.snapshot.code);
  }, [engine, leaveCallInternal]);

  const value = useMemo<CallCtx>(
    () => ({
      engine,
      snapshot,
      incoming,
      target,
      role,
      startOutgoing,
      acceptIncoming,
      declineIncoming,
      joinByCode,
      leaveCall,
    }),
    [engine, snapshot, incoming, target, role, startOutgoing, acceptIncoming, declineIncoming, joinByCode, leaveCall],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
