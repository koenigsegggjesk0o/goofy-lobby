/** goofy hub — buat room suara, gabung via kode, bagikan kode ke teman. */
import { useState, type ReactNode } from 'react';
import { useCall } from '../state/call';
import { useApp } from '../state/store';
import { useToast } from '../state/toast';
import { messagesSvc } from '../lib/services';
import { callInviteBody } from '../lib/protocol';
import { Icon } from '../lib/icons';
import { normalizeRoomCode } from '../../webrtc/types';

export default function HubView(): ReactNode {
  const { snapshot, engine, joinByCode } = useCall();
  const { user, profile, friends, sendPoke } = useApp();
  const { toast } = useToast();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const inRoom = snapshot.status !== 'idle';

  const selfSession = (): { sessionId: string; userId: string; displayName: string; avatarColor: string } => {
    if (user === null) throw new Error('belum masuk');
    return {
      sessionId: `u-${crypto.randomUUID().slice(0, 12)}`,
      userId: user.id,
      displayName: profile?.displayName ?? 'goofy user',
      avatarColor: profile?.avatarColor ?? '#9ca3af',
    };
  };

  const create = async (): Promise<void> => {
    if (busy || inRoom) return;
    setBusy(true);
    try {
      await engine.start({ mode: 'create', self: selfSession() });
    } catch (error) {
      toast(error instanceof Error ? error.message : 'gagal membuat room', 'error');
    } finally {
      setBusy(false);
    }
  };

  const join = async (): Promise<void> => {
    const normalized = normalizeRoomCode(code);
    if (normalized.length !== 8) {
      toast('Kode room 8 karakter (tanpa I/L/O/U)', 'error');
      return;
    }
    setBusy(true);
    try {
      await joinByCode(normalized);
      setCode('');
    } catch {
      // toast sudah ditangani joinByCode
    } finally {
      setBusy(false);
    }
  };

  const shareTo = async (friendId: string): Promise<void> => {
    if (user === null || snapshot.code === null) return;
    try {
      await messagesSvc().sendMessage(user.id, friendId, callInviteBody(snapshot.code));
      sendPoke(friendId, 'dm');
      toast('Undangan terkirim', 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'gagal mengirim undangan', 'error');
    }
  };

  return (
    <div className="hub">
      <header className="hub__header">
        <div className="hub__title">
          <Icon name="speaker" size={26} />
          <h2>goofy hub</h2>
        </div>
        <p className="hub__sub">Room suara spasial — sampai 8 orang, posisi bebas, suara mengikuti arah.</p>
      </header>

      <div className="hub__cards">
        <section className="hubcard" aria-label="Buat room">
          <h3>Buat room baru</h3>
          <p>Sistem menerbitkan kode 8 karakter — bagikan ke teman lewat DM.</p>
          <button className="btn btn--primary" disabled={busy || inRoom} onClick={() => void create()}>
            <Icon name="plus" size={20} />
            {busy ? 'Menyiapkan…' : 'Buat room suara'}
          </button>
          {inRoom && snapshot.code !== null ? (
            <p className="hubcard__live">
              <span className="dot dot--online dot--pulse" aria-hidden="true" /> room aktif:{' '}
              <strong>{snapshot.code}</strong> — detail ada di layar panggilan
            </p>
          ) : null}
        </section>

        <section className="hubcard" aria-label="Gabung via kode">
          <h3>Gabung via kode</h3>
          <p>Masukkan kode dari temanmu (huruf O/I/L dibaca 0/1/1).</p>
          <div className="hubcard__join">
            <input
              className="hubcard__input"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 8))}
              placeholder="XXXXXXXX"
              aria-label="Kode room"
              maxLength={8}
              spellCheck={false}
              disabled={inRoom}
            />
            <button
              className="btn btn--primary"
              disabled={busy || inRoom || code.length !== 8}
              onClick={() => void join()}
            >
              Gabung
            </button>
          </div>
        </section>

        {inRoom && snapshot.code !== null ? (
          <section className="hubcard hubcard--share" aria-label="Ajak teman">
            <h3>Ajak teman</h3>
            <p>Kirim undangan room {snapshot.code}:</p>
            <div className="hubcard__friends">
              {friends.length === 0 ? <span className="hubcard__none">Belum ada teman — tambah dulu di tab Teman.</span> : null}
              {friends.map((f) => (
                <button key={f.friendshipId} className="hubchip" onClick={() => void shareTo(f.friendId)}>
                  <span
                    className="avatar__img avatar__img--24"
                    style={{ ['--av-c' as string]: f.profile.avatarColor }}
                  >
                    {f.profile.displayName.slice(0, 1).toUpperCase()}
                  </span>
                  {f.profile.displayName}
                  <Icon name="send" size={14} />
                </button>
              ))}
            </div>
          </section>
        ) : null}
      </div>

      <section className="hub__tips" aria-label="Cara kerja audio spasial">
        <h4>Cara kerja audio spasial</h4>
        <ul>
          <li>Setiap peserta tampil sebagai bola di panggung — seret bolamu, posisimu terkirim ±15×/detik.</li>
          <li>Suara diproses HRTF per posisi: makin jauh makin pelan, kiri/kanan mengikuti arah.</li>
          <li>Relay TURN ephemeral aktif otomatis untuk jaringan yang memblokir UDP langsung.</li>
        </ul>
      </section>
    </div>
  );
}
