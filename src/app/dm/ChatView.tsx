/**
 * Tampilan percakapan DM — riwayat + kirim pesan realtime (poke + poll)
 * + kartu undangan panggilan ([goofy-call] CODE → tombol Gabung).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useApp } from '../state/store';
import { useCall } from '../state/call';
import { useToast } from '../state/toast';
import { messagesSvc } from '../lib/services';
import { parseCallInvite, parseCallDeclined, parseCallEnd } from '../lib/protocol';
import { Icon } from '../lib/icons';
import { clockOf, dayLabel, messageStamp } from '../lib/time';
import type { ChatMessage } from '../../chat/types';

export default function ChatView({ userId }: { userId: string }): ReactNode {
  const { user, getPerson, isOnline, dmVersion, sendPoke, markRead, openPopout, dms } = useApp();
  const { startOutgoing, snapshot, joinByCode } = useCall();
  const { toast } = useToast();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  const me = user;
  const person = getPerson(userId);
  const online = isOnline(userId);

  const load = useCallback(async () => {
    if (me === null) return;
    try {
      const list = await messagesSvc().listConversation(me.id, userId, { limit: 50 });
      setMessages(list);
    } catch (error) {
      console.warn('[goofy] memuat percakapan gagal:', error);
    }
  }, [me, userId]);

  useEffect(() => {
    void load();
    markRead(userId);
  }, [load, markRead, userId, dmVersion]);

  useEffect(() => {
    markRead(userId);
  }, [dms, markRead, userId]);

  // Gulir otomatis ke bawah saat baru buka / pesan baru datang.
  useEffect(() => {
    const el = scrollerRef.current;
    if (el === null || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = (): void => {
    const el = scrollerRef.current;
    if (el === null) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const send = async (): Promise<void> => {
    const body = draft.trim();
    if (body === '' || me === null || sending) return;
    setSending(true);
    setDraft('');
    try {
      const sent = await messagesSvc().sendMessage(me.id, userId, body);
      setMessages((prev) => [...prev, sent]);
      stickToBottom.current = true;
      sendPoke(userId, 'dm');
    } catch (error) {
      setDraft(body);
      const code = (error as { code?: string }).code;
      const text =
        code === 'not-friends'
          ? 'Kalian bukan teman lagi — pesan tidak terkirim'
          : code === 'rate-limited'
            ? 'Terlalu cepat — tunggu sebentar'
            : code === 'invalid-body'
              ? 'Pesan kosong atau terlalu panjang (maks 500)'
              : 'Pesan gagal terkirim';
      toast(text, 'error');
    } finally {
      setSending(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const groups = useMemo(() => buildGroups(messages, me?.id ?? ''), [messages, me?.id]);

  if (me === null) return null;
  const name = person?.displayName ?? 'pengguna';

  return (
    <div className="chatview">
      <header className="chat__header">
        <div className="chat__header-id">
          <button
            className="chat__header-avatar"
            aria-label={`Buka profil ${name}`}
            onClick={(e) => person !== null && openPopout(person, e.clientX, e.clientY)}
          >
            <span className="avatar avatar--24">
              <span className="avatar__img" style={{ ['--av-c' as string]: person?.avatarColor ?? '#757e8a' }}>
                {name.slice(0, 1).toUpperCase()}
              </span>
              <span className={`dot ${online ? 'dot--online' : 'dot--offline'}`} />
            </span>
          </button>
          <span className="chat__title">{name}</span>
          <span className="chat__status">{online ? 'online' : 'offline'}</span>
        </div>
        <div className="chat__header-actions">
          <button
            className="iconbtn"
            aria-label={`Telepon ${name}`}
            title="Telepon (suara spasial)"
            disabled={snapshot.status !== 'idle'}
            onClick={() => person !== null && void startOutgoing(person)}
          >
            <Icon name="phone" size={24} />
          </button>
          <button className="iconbtn" aria-label="Video call" title="Video call — segera" disabled>
            <Icon name="video" size={24} />
          </button>
        </div>
      </header>

      <div className="messages" role="log" aria-label={`Percakapan dengan ${name}`}>
        <div className="messages__scroller" ref={scrollerRef} onScroll={onScroll}>
          <div className="intro">
            <span className="avatar avatar--80">
              <span className="avatar__img" style={{ ['--av-c' as string]: person?.avatarColor ?? '#757e8a' }}>
                {name.slice(0, 1).toUpperCase()}
              </span>
              <span className={`dot ${online ? 'dot--online' : 'dot--offline'} dot--lg`} />
            </span>
            <h1 className="intro__title">{name}</h1>
            <p className="intro__sub">
              Ini awal dari riwayat percakapan langsung kamu dengan <strong>{name}</strong>.
            </p>
          </div>

          {groups.map((group) => (
            <div key={group.day}>
              <div className="divider" role="separator">
                <span>{group.day}</span>
              </div>
              {group.items.map((item) => (
                <MessageItem key={item.message.id} item={item} meId={me.id} onJoin={joinByCode} />
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="composer">
        <div className="composer__inner">
          <button className="iconbtn iconbtn--composer" aria-label="Lampiran — segera" title="Lampiran — segera" disabled>
            <Icon name="plus" size={24} />
          </button>
          <textarea
            className="composer__ta"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            placeholder={`Kirim pesan ke @${name}`}
            aria-label={`Kirim pesan ke ${name}`}
            maxLength={500}
            rows={1}
          />
          <div className="composer__tools">
            <button className="iconbtn iconbtn--composer" aria-label="GIF — segera" title="GIF — segera" disabled>
              <Icon name="gif" size={24} />
            </button>
            <button className="iconbtn iconbtn--composer" aria-label="Stiker — segera" title="Stiker — segera" disabled>
              <Icon name="sticker" size={24} />
            </button>
            <button
              className="iconbtn iconbtn--composer"
              aria-label={draft.trim() === '' ? 'Ketik pesan dulu' : 'Kirim pesan'}
              title="Kirim"
              disabled={draft.trim() === '' || sending}
              onClick={() => void send()}
            >
              <Icon name="send" size={22} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface GroupedItem {
  message: ChatMessage;
  mine: boolean;
  showHead: boolean;
}

interface DayGroup {
  day: string;
  items: GroupedItem[];
}

function buildGroups(messages: ChatMessage[], meId: string): DayGroup[] {
  const groups: DayGroup[] = [];
  let currentDay = '';
  let lastSender = '';
  let lastAt = 0;
  for (const message of messages) {
    const day = dayLabel(message.createdAt);
    if (day !== currentDay) {
      groups.push({ day, items: [] });
      currentDay = day;
      lastSender = '';
      lastAt = 0;
    }
    const group = groups[groups.length - 1];
    if (group === undefined) continue;
    const gapMs = new Date(message.createdAt).getTime() - lastAt;
    const showHead = message.senderId !== lastSender || gapMs > 5 * 60_000;
    group.items.push({ message, mine: message.senderId === meId, showHead });
    lastSender = message.senderId;
    lastAt = new Date(message.createdAt).getTime();
  }
  return groups;
}

function MessageItem({
  item,
  meId,
  onJoin,
}: {
  item: GroupedItem;
  meId: string;
  onJoin: (code: string) => Promise<void>;
}): ReactNode {
  const { getPerson, profile } = useApp();
  const { snapshot } = useCall();
  const message = item.message;
  const sender = message.senderId === meId ? null : getPerson(message.senderId);

  const inviteCode = parseCallInvite(message.body);
  const declinedCode = parseCallDeclined(message.body);
  const endCode = parseCallEnd(message.body);

  if (inviteCode !== null || declinedCode !== null || endCode !== null) {
    return (
      <div className="msg" role="article">
        <div className="msg__gutter">
          {item.showHead && sender !== null ? (
            <span className="avatar avatar--40">
              <span className="avatar__img" style={{ ['--av-c' as string]: sender.avatarColor }}>
                {sender.displayName.slice(0, 1).toUpperCase()}
              </span>
            </span>
          ) : (
            <span className="msg__gutter-time">{clockOf(message.createdAt)}</span>
          )}
        </div>
        <div className="msg__main">
          {item.showHead && sender !== null ? (
            <div className="msg__head">
              <span className="msg__name" style={{ ['--name-c' as string]: sender.avatarColor }}>
                {sender.displayName}
              </span>
              <span className="msg__time">{messageStamp(message.createdAt)}</span>
            </div>
          ) : null}
          <div className="msg__body">
            {inviteCode !== null ? (
              <div className="invite-card">
                <div className="invite-card__ic">
                  <Icon name="phone" size={24} />
                </div>
                <div className="invite-card__body">
                  <span className="invite-card__title">Undangan panggilan suara</span>
                  <span className="invite-card__sub">room {inviteCode}</span>
                </div>
                <button
                  className="btn btn--primary btn--sm"
                  disabled={snapshot.status !== 'idle'}
                  onClick={() => void onJoin(inviteCode)}
                >
                  Gabung
                </button>
              </div>
            ) : null}
            {declinedCode !== null ? (
              <p className="sysline">— panggilan ditolak —</p>
            ) : null}
            {endCode !== null ? <p className="sysline">— panggilan berakhir —</p> : null}
          </div>
        </div>
      </div>
    );
  }

  const name = sender?.displayName ?? profile?.displayName ?? 'goofy';
  const color = sender?.avatarColor ?? profile?.avatarColor ?? '#757e8a';

  return (
    <div className={`msg${item.showHead ? '' : ' msg--grouped'}`} role="article">
      <div className="msg__gutter">
        {item.showHead ? (
          <span className="avatar avatar--40">
            <span className="avatar__img" style={{ ['--av-c' as string]: color }}>
              {name.slice(0, 1).toUpperCase()}
            </span>
          </span>
        ) : (
          <span className="msg__gutter-time">{clockOf(message.createdAt)}</span>
        )}
      </div>
      <div className="msg__main">
        {item.showHead ? (
          <div className="msg__head">
            <span className="msg__name" style={{ ['--name-c' as string]: color }}>
              {name}
            </span>
            <span className="msg__time">{messageStamp(message.createdAt)}</span>
          </div>
        ) : null}
        <div className="msg__body">
          <p>{message.body}</p>
        </div>
      </div>
    </div>
  );
}
