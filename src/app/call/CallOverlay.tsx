/**
 * Overlay panggilan — tiga wajah:
 *  1. KELUAR (ringing)  : avatar lawan berdenyut + "Memanggil…"
 *  2. MASUK (incoming)  : Terima / Tolak (dari deteksi DM [goofy-call])
 *  3. AKTIF (active)    : panggung spasial (seret bolamu) + kontrol.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { useApp } from '../state/store';
import { useCall } from '../state/call';
import { useToast } from '../state/toast';
import { Icon } from '../lib/icons';
import { callDuration } from '../lib/time';
import { STAGE_BOUND_M } from '../state/callEngine';

export default function CallOverlay(): ReactNode {
  const { incoming, target, snapshot, engine, role, acceptIncoming, declineIncoming, leaveCall } = useCall();
  const { getPerson } = useApp();

  if (incoming !== null && snapshot.status === 'idle') {
    return <IncomingFace from={incoming.from} onAccept={() => void acceptIncoming()} onDecline={() => void declineIncoming()} />;
  }
  if (snapshot.status === 'connecting' || snapshot.status === 'ringing') {
    const person = target;
    const name = person?.displayName ?? 'goofy hub';
    const waitText =
      snapshot.status === 'connecting'
        ? 'Menyiapkan room…'
        : target === null
          ? 'Menunggu peserta — bagikan kode room…'
          : role === 'callee'
            ? `Menyambungkan ke ${name}…`
            : `Memanggil ${name}…`;
    return (
      <Face>
        <div className="ringwrap" role="status" aria-label={waitText}>
          <span className="avatar avatar--96">
            <span className="avatar__img" style={{ ['--av-c' as string]: person?.avatarColor ?? '#5865f2' }}>
              {name.slice(0, 1).toUpperCase()}
            </span>
            <span className="ring ring--1" aria-hidden="true" />
            <span className="ring ring--2" aria-hidden="true" />
          </span>
          <h2 className="face__title">{waitText}</h2>
          <p className="face__sub">
            {snapshot.ice === 'ephemeral-turn' ? 'relay TURN aman aktif' : 'mencoba menyambungkan…'}
          </p>
          <button className="btn btn--danger" onClick={() => void leaveCall()}>
            <Icon name="phoneOff" size={20} />
            Batalkan
          </button>
        </div>
      </Face>
    );
  }
  if (snapshot.status === 'active') {
    return <ActiveFace snapshot={snapshot} engine={engine} getPerson={getPerson} onLeave={() => void leaveCall()} />;
  }
  return null;
}

function Face({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="calloverlay" role="dialog" aria-modal="true" aria-label="Panggilan suara">
      {children}
    </div>
  );
}

function IncomingFace({
  from,
  onAccept,
  onDecline,
}: {
  from: { displayName: string; avatarColor: string };
  onAccept: () => void;
  onDecline: () => void;
}): ReactNode {
  return (
    <Face>
      <div className="ringwrap" role="alert" aria-label={`Panggilan masuk dari ${from.displayName}`}>
        <span className="avatar avatar--96">
          <span className="avatar__img" style={{ ['--av-c' as string]: from.avatarColor }}>
            {from.displayName.slice(0, 1).toUpperCase()}
          </span>
          <span className="ring ring--1" aria-hidden="true" />
          <span className="ring ring--2" aria-hidden="true" />
        </span>
        <h2 className="face__title">Panggilan masuk</h2>
        <p className="face__sub">{from.displayName} mengundangmu ke room suara</p>
        <div className="face__row">
          <button className="btn btn--accept" onClick={onAccept} aria-label="Terima panggilan">
            <Icon name="phone" size={20} />
            Terima
          </button>
          <button className="btn btn--danger" onClick={onDecline} aria-label="Tolak panggilan">
            <Icon name="phoneOff" size={20} />
            Tolak
          </button>
        </div>
      </div>
    </Face>
  );
}

interface ActiveProps {
  snapshot: ReturnType<typeof useCall>['snapshot'];
  engine: ReturnType<typeof useCall>['engine'];
  getPerson: (userId: string) => { id: string; displayName: string; avatarColor: string } | null;
  onLeave: () => void;
}

function ActiveFace({ snapshot, engine, getPerson, onLeave }: ActiveProps): ReactNode {
  const { toast } = useToast();
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const worldFromEvent = useCallback((clientX: number, clientY: number): { x: number; y: number } => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (rect === undefined) return { x: 0, y: 0 };
    const nx = (clientX - rect.left) / rect.width; // 0..1
    const ny = (clientY - rect.top) / rect.height;
    return {
      x: (nx * 2 - 1) * STAGE_BOUND_M,
      y: -(ny * 2 - 1) * STAGE_BOUND_M, // dunia y+ = atas panggung
    };
  }, []);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const p = worldFromEvent(e.clientX, e.clientY);
    engine.moveSelf(p.x, p.y);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return;
    const p = worldFromEvent(e.clientX, e.clientY);
    engine.moveSelf(p.x, p.y);
  };
  const onPointerUp = (): void => {
    dragging.current = false;
  };

  const copyCode = async (): Promise<void> => {
    if (snapshot.code === null) return;
    try {
      await navigator.clipboard.writeText(snapshot.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast('Gagal menyalin — salin manual dari layar', 'error');
    }
  };

  const self = snapshot.self;
  const participants: Array<{
    key: string;
    name: string;
    color: string;
    x: number;
    y: number;
    speaking: boolean;
    you: boolean;
    muted: boolean;
    state: string;
  }> = [];

  if (self !== null) {
    participants.push({
      key: 'self',
      name: self.displayName,
      color: self.avatarColor,
      x: snapshot.selfPosition?.x ?? 0,
      y: snapshot.selfPosition?.y ?? 0,
      speaking: snapshot.selfSpeaking,
      you: true,
      muted: snapshot.micMuted,
      state: 'ok',
    });
  }
  snapshot.peers.forEach((peer, index) => {
    const fallbackAngle = (Math.PI * 2 * (index + 1)) / (snapshot.peers.length + 1);
    const pos = peer.lastPosition ?? { x: Math.cos(fallbackAngle) * 1.6, y: Math.sin(fallbackAngle) * 1.6 };
    participants.push({
      key: peer.sessionId,
      name: peer.session.displayName,
      color: peer.session.avatarColor,
      x: pos.x,
      y: pos.y,
      speaking: snapshot.speaking.has(peer.sessionId),
      you: false,
      muted: false,
      state: peer.connectionState,
    });
  });
  void getPerson;

  return (
    <Face>
      <div className="callactive">
        <header className="callactive__top">
          <div className="callactive__code" title="Kode room — bagikan ke teman">
            <Icon name="hash" size={16} />
            <span className="callactive__code-text">{snapshot.code}</span>
            <button
              className="iconbtn iconbtn--topbar"
              onClick={() => void copyCode()}
              aria-label="Salin kode room"
              title="Salin kode"
            >
              <Icon name={copied ? 'check' : 'copy'} size={16} />
            </button>
          </div>
          {!snapshot.micAvailable ? (
            <span className="callactive__listenonly" title="Device mikrofon tidak ditemukan">
              <Icon name="micOff" size={14} /> mode dengar-saja
            </span>
          ) : null}
          <span className="callactive__timer" role="timer" aria-label="Durasi panggilan">
            <span className="dot dot--online dot--pulse" aria-hidden="true" />
            {callDuration(snapshot.startedAt ?? Date.now(), now)}
          </span>
          <span className="callactive__ice" title={snapshot.ice === 'ephemeral-turn' ? 'TURN ephemeral (relay aman)' : snapshot.ice === 'static-turn' ? 'TURN statis' : 'STUN langsung'}>
            <Icon name="signal" size={16} />
            {snapshot.ice === 'ephemeral-turn' ? 'TURN' : snapshot.ice === 'static-turn' ? 'TURN' : 'P2P'}
          </span>
        </header>

        <div
          className={`stage${dragging.current ? ' stage--drag' : ''}`}
          ref={stageRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          role="application"
          aria-label="Panggung spasial — klik atau seret untuk memindahkan posimu"
        >
          <span className="stage__grid" aria-hidden="true" />
          <p className="stage__hint">klik / seret di mana saja — posisimu ikut, suara mengikuti</p>
          {participants.map((p) => (
            <div
              key={p.key}
              className={`stageDot${p.speaking ? ' is-speaking' : ''}${p.you ? ' is-you' : ''}`}
              style={{
                left: `${((p.x / STAGE_BOUND_M) * 0.5 + 0.5) * 100}%`,
                top: `${((p.y / STAGE_BOUND_M) * 0.5 + 0.5) * 100}%`,
              }}
              aria-label={`${p.name}${p.you ? ' (kamu)' : ''}${p.speaking ? ' sedang bicara' : ''}`}
            >
              <span className="stageDot__ring" aria-hidden="true" />
              <span className="avatar avatar--48">
                <span className="avatar__img" style={{ ['--av-c' as string]: p.color }}>
                  {p.name.slice(0, 1).toUpperCase()}
                </span>
              </span>
              {p.muted ? <span className="stageDot__muted" aria-label="mikrofon mati"><Icon name="micOff" size={12} /></span> : null}
              <span className="stageDot__name">
                {p.you ? `${p.name} (kamu)` : p.name}
                {p.state !== 'connected' && !p.you ? <em> · menyambung…</em> : null}
              </span>
            </div>
          ))}
        </div>

        <footer className="callactive__controls">
          <button
            className={`cbtn${snapshot.micMuted ? ' is-danger' : ''}`}
            aria-pressed={snapshot.micMuted}
            aria-label={snapshot.micMuted ? 'Nyalakan mikrofon' : 'Bisukan mikrofon'}
            title={snapshot.micAvailable ? (snapshot.micMuted ? 'Nyalakan mikrofon' : 'Bisukan mikrofon') : 'Mikrofon tidak tersedia di perangkat ini'}
            disabled={!snapshot.micAvailable}
            onClick={() => engine.setMicMuted(!snapshot.micMuted)}
          >
            <Icon name={snapshot.micMuted ? 'micOff' : 'mic'} size={22} />
          </button>
          <button
            className={`cbtn${snapshot.deafened ? ' is-danger' : ''}`}
            aria-pressed={snapshot.deafened}
            aria-label={snapshot.deafened ? 'Nyalakan audio' : 'Bisukan audio'}
            title={snapshot.deafened ? 'Nyalakan audio' : 'Bisukan audio'}
            onClick={() => engine.setDeafened(!snapshot.deafened)}
          >
            <Icon name={snapshot.deafened ? 'headphonesOff' : 'headphones'} size={22} />
          </button>
          <button
            className="cbtn cbtn--hang"
            aria-label="Tutup panggilan"
            title="Tutup panggilan"
            onClick={onLeave}
          >
            <Icon name="phoneOff" size={22} />
          </button>
        </footer>
      </div>
    </Face>
  );
}
