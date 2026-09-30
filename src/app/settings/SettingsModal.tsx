/** Modal pengaturan — ubah profil (nama + warna) + keluar. */
import { useEffect, useState, type ReactNode } from 'react';
import { useApp } from '../state/store';
import { Icon } from '../lib/icons';

const COLOR_CHOICES = [
  '#e67146',
  '#23a55a',
  '#5865f2',
  '#eb459e',
  '#faa61a',
  '#3d9e60',
  '#dc4247',
  '#9ca3af',
];

export default function SettingsModal(): ReactNode {
  const { profile, setSettingsOpen, saveProfile, logout, user } = useApp();
  const [name, setName] = useState(profile?.displayName ?? '');
  const [color, setColor] = useState(profile?.avatarColor ?? '#9ca3af');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setSettingsOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setSettingsOpen]);

  const dirty =
    name.trim() !== (profile?.displayName ?? '') || color !== (profile?.avatarColor ?? '#9ca3af');

  const save = async (): Promise<void> => {
    if (busy || name.trim().length < 2) return;
    setBusy(true);
    await saveProfile({ displayName: name.trim(), avatarColor: color });
    setBusy(false);
  };

  return (
    <div className="modal-scrim" role="presentation" onClick={() => setSettingsOpen(false)}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Pengaturan"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal__head">
          <h2>Pengaturan</h2>
          <button className="iconbtn" aria-label="Tutup pengaturan" onClick={() => setSettingsOpen(false)}>
            <Icon name="x" size={20} />
          </button>
        </header>

        <div className="modal__body">
          <section className="sprofile">
            <span className="avatar avatar--80">
              <span className="avatar__img" style={{ ['--av-c' as string]: color }}>
                {(name.trim() === '' ? '?' : name.trim().slice(0, 1)).toUpperCase()}
              </span>
              <span className="dot dot--online dot--lg" />
            </span>
            <div className="sprofile__fields">
              <label className="field">
                <span className="field__label">NAMA TAMPILAN</span>
                <input
                  className="field__input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={32}
                  placeholder="Namamu"
                />
              </label>
              <p className="sprofile__email">{user?.email ?? ''}</p>
              <div>
                <span className="field__label">WARNA AVATAR</span>
                <div className="swatches" role="radiogroup" aria-label="Warna avatar">
                  {COLOR_CHOICES.map((c) => (
                    <button
                      key={c}
                      role="radio"
                      aria-checked={color === c}
                      aria-label={`warna ${c}`}
                      className={`swatch${color === c ? ' is-active' : ''}`}
                      style={{ background: c }}
                      onClick={() => setColor(c)}
                    />
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section className="modal__actions">
            <button className="btn btn--primary" disabled={!dirty || busy || name.trim().length < 2} onClick={() => void save()}>
              {busy ? <span className="spinner spinner--sm" aria-hidden="true" /> : null}
              Simpan
            </button>
            <button className="btn btn--ghost btn--danger-ghost" onClick={() => void logout()}>
              <Icon name="logout" size={18} />
              Keluar
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}
