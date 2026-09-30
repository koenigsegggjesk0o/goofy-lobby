/** Popout profil — kartu mini di dekat titik klik: identitas + aksi cepat. */
import { useEffect, useRef, type ReactNode } from 'react';
import { useApp } from '../state/store';
import { useCall } from '../state/call';
import { Icon } from '../lib/icons';
import { sinceLabel } from '../lib/time';

export default function ProfilePopout(): ReactNode {
  const { popout, closePopout, openDm, friends, isOnline } = useApp();
  const { startOutgoing, snapshot } = useCall();
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closePopout();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closePopout]);

  if (popout === null) return null;
  const { person } = popout;
  const friendEntry = friends.find((f) => f.friendId === person.id) ?? null;
  const online = isOnline(person.id);

  const clamp = (value: number, max: number): number => Math.max(8, Math.min(value, max));
  const x = clamp(popout.x - 150, window.innerWidth - 320);
  const y = clamp(popout.y + 12, window.innerHeight - 260);

  return (
    <div className="popout-scrim" onClick={closePopout} aria-hidden="true">
      <div
        className="popout"
        role="dialog"
        aria-label={`Profil ${person.displayName}`}
        style={{ left: x, top: y }}
        ref={ref}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="popout__banner" style={{ ['--av-c' as string]: person.avatarColor }}>
          <span className="avatar avatar--80">
            <span className="avatar__img" style={{ ['--av-c' as string]: person.avatarColor }}>
              {person.displayName.slice(0, 1).toUpperCase()}
            </span>
            <span className={`dot ${online ? 'dot--online' : 'dot--offline'} dot--lg`} />
          </span>
        </div>
        <div className="popout__body">
          <h3 className="popout__name">{person.displayName}</h3>
          <p className="popout__sub">{online ? 'Online' : 'Offline'}</p>
          {friendEntry !== null ? (
            <p className="popout__since">Pertemanan {sinceLabel(friendEntry.since)}</p>
          ) : null}
          <div className="popout__actions">
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => {
                openDm(person.id);
                closePopout();
              }}
            >
              <Icon name="hash" size={16} />
              Kirim Pesan
            </button>
            {friendEntry !== null ? (
              <button
                className="btn btn--primary btn--sm"
                disabled={snapshot.status !== 'idle'}
                onClick={() => {
                  void startOutgoing(person);
                  closePopout();
                }}
              >
                <Icon name="phone" size={16} />
                Telepon
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
