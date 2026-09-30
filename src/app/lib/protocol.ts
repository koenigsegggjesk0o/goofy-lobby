/**
 * Protokol undangan panggilan lewat DM — body pesan bertindak sebagai
 * transport sinyal (lapisan tipis di atas messages):
 *   [goofy-call] CODE      — undangan (caller → callee)
 *   [goofy-declined] CODE  — ditolak (callee → caller)
 *   [goofy-end] CODE       — ditutup (salah satu pihak)
 * Kode room: 8 karakter Crockford-32 tanpa I/L/O/U (sama dengan server).
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const CALL_INVITE_PREFIX = '[goofy-call] ';
export const CALL_DECLINED_PREFIX = '[goofy-declined] ';
export const CALL_END_PREFIX = '[goofy-end] ';

const codeRegex = new RegExp(`^([${ALPHABET}]{8})$`);

function parseWith(prefix: string, body: string): string | null {
  if (!body.startsWith(prefix)) return null;
  const code = body.slice(prefix.length).trim().toUpperCase();
  return codeRegex.test(code) ? code : null;
}

export function parseCallInvite(body: string): string | null {
  return parseWith(CALL_INVITE_PREFIX, body);
}
export function parseCallDeclined(body: string): string | null {
  return parseWith(CALL_DECLINED_PREFIX, body);
}
export function parseCallEnd(body: string): string | null {
  return parseWith(CALL_END_PREFIX, body);
}

export function callInviteBody(code: string): string {
  return `${CALL_INVITE_PREFIX}${code}`;
}
export function callDeclinedBody(code: string): string {
  return `${CALL_DECLINED_PREFIX}${code}`;
}
export function callEndBody(code: string): string {
  return `${CALL_END_PREFIX}${code}`;
}

/** Undangan masih "segar" (untuk auto-ring) — 45 detik. */
export const INVITE_FRESH_MS = 45_000;
