/** Rail kiri — Beranda (teman+DM) dan hub room suara. */
import type { ReactNode } from 'react';
import { useApp } from '../state/store';
import { useCall } from '../state/call';
import { Icon } from '../lib/icons';

export default function ServerRail(): ReactNode {
  const { rail, openFriends, openHub, setSettingsOpen } = useApp();
  const { snapshot } = useCall();
  const homeActive = rail === 'home';
  const hubActive = rail === 'hub';

  return (
    <nav className="rail" aria-label="Navigasi utama">
      <div className="rail__scroller">
        <button
          className={`rail__item rail__item--home${homeActive ? ' is-active' : ''}`}
          onClick={openFriends}
          aria-label="Pesan Langsung dan Teman"
          aria-current={homeActive ? 'page' : undefined}
          title="Pesan Langsung"
        >
          <span className="pill" aria-hidden="true" />
          <span className={`rail__icon${homeActive ? '' : ' rail__icon--off'}`}>
            <Icon name="friends" size={24} />
          </span>
        </button>

        <button
          className={`rail__item rail__item--srv${hubActive ? ' is-active' : ''}`}
          onClick={openHub}
          aria-label="goofy hub — room suara spasial"
          aria-current={hubActive ? 'page' : undefined}
          title="goofy hub"
          style={{ ['--srv-c' as string]: snapshot.status !== 'idle' ? '#23a55a' : '#eb459e' }}
        >
          <span className="pill" aria-hidden="true" />
          <span className="rail__icon rail__icon--srv">
            <Icon name="speaker" size={22} />
          </span>
          {snapshot.status !== 'idle' ? (
            <span className="rail__live" aria-label="sedang dalam room suara">
              LIVE
            </span>
          ) : null}
        </button>

        <div className="rail__sep" role="separator" aria-hidden="true" />

        <button
          className="rail__item rail__item--action"
          onClick={() => setSettingsOpen(true)}
          aria-label="Pengaturan"
          title="Pengaturan"
        >
          <span className="pill" aria-hidden="true" />
          <span className="rail__icon rail__icon--add">
            <Icon name="gear" size={22} />
          </span>
        </button>
        <div className="rail__scroller-end" />
      </div>
    </nav>
  );
}
