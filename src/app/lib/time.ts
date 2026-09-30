/** Format waktu gaya Discord-Indonesia. */

const timeFmt = new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
const shortDayFmt = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });

/** "14.21" */
export function clockOf(iso: string): string {
  return timeFmt.format(new Date(iso)).replace(':', '.');
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getDate() === b.getDate() && a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear()
  );
}

/** "Hari Ini pukul 14.21" / "Kemarin pukul 14.21" / "12 September 2026 pukul 14.21" */
export function messageStamp(iso: string): string {
  const at = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const time = timeFmt.format(at).replace(':', '.');
  if (sameDay(at, today)) return `Hari Ini pukul ${time}`;
  if (sameDay(at, yesterday)) return `Kemarin pukul ${time}`;
  return `${dayFmt.format(at)} pukul ${time}`;
}

/** Label tanggal untuk divider: "Hari Ini" / "Kemarin" / tanggal. */
export function dayLabel(iso: string): string {
  const at = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(at, today)) return 'Hari Ini';
  if (sameDay(at, yesterday)) return 'Kemarin';
  return dayFmt.format(at);
}

/** "sejak 12 Sep 2026" */
export function sinceLabel(iso: string): string {
  return `sejak ${shortDayFmt.format(new Date(iso))}`;
}

/** Durasi panggilan "04:12". */
export function callDuration(startedAt: number, now: number): string {
  const total = Math.max(0, Math.floor((now - startedAt) / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}
