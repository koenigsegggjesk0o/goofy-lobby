#!/usr/bin/env bun
/**
 * scripts/db/verify-p0-1.mjs — VERIFIKASI CLOUD P0-1 (Task 23 hardening).
 * Generator bukti Definition-of-Done P0-1: channel room:{kode} private +
 * RLS realtime.messages + registri room + rate-limit join server-side.
 *
 * === CARA PAKAI (kredensial via env INLINE — DILARANG ditulis ke file) ===
 *   SUPABASE_PROJECT_REF=xxx SUPABASE_ACCESS_TOKEN=sbp_xxx \
 *   VITE_SUPABASE_URL=https://xxx.supabase.co VITE_SUPABASE_ANON_KEY=eyJxxx \
 *   SUPABASE_SERVICE_ROLE_KEY=eyJxxx \
 *   bun scripts/db/verify-p0-1.mjs
 *
 * === YANG DIKERJAKAN (urutan) ===
 *  0. Preflight env (nilai DIBEREDAKTI — tidak dicetak penuh).
 *  1. Apply migrasi 0016 + 0017 via Management API (skip bila sudah applied).
 *  2. Baca config Realtime → PATCH private_only=true ("Allow public access"
 *     = OFF — syarat penegakan penuh; tanpa ini penyerang bisa subscribe
 *     channel TANPA flag private dan melewati RLS) → konfirmasi GET ulang.
 *  3. Buat 3 user uji sekali pakai via Auth Admin API (A=host, B=penyerang,
 *     C=tamu sah) + signin (password grant + captcha dummy; fallback
 *     generate_link/token_hash).
 *  4. Matriks pengujian (setiap baris = bukti PASS/FAIL tercetak):
 *     T1  A create_room()            → kode Crockford-32 8 karakter.
 *     T2  A subscribe PRIVATE        → SUBSCRIBED (regresi: jalur sah jalan).
 *     T3  A track presence           → 'ok'.
 *     T4  B (tanpa tiket) subscribe  → CHANNEL_ERROR "Unauthorized..." —
 *                                     INILAH PENUTUPAN KEBOCORAN IP.
 *     T5  anon (tanpa sesi) subscribe→ ditolak.
 *     T6  B join format salah        → INVALID_ROOM_CODE.
 *     T7  B brute-force 12x          → kena RATE_LIMITED (server-side).
 *     T8  C join + subscribe         → SUBSCRIBED + MENERIMA broadcast A
 *                                     (regresi signaling end-to-end) +
 *                                     presence saling terlihat.
 *     T9  A subscribe NON-private    → ditolak (PrivateOnly) — bukti toggle
 *                                     bekerja (bypass flag private mati).
 *  5. Bukti state via SQL read-only (policy realtime.messages + room row).
 *  6. Cleanup: leave_room, removeChannel, hapus 3 user uji (CASCADE
 *     membersihkan rooms/participants/attempts).
 *
 * Exit code: 0 = semua PASS; 1 = ada FAIL; 2 = blocker konfigurasi
 * (mis. token tanpa scope realtime_config_write).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

// ============================================================
// Env preflight
// ============================================================

function requiredEnv(name) {
  const value =
    process.env[name] ??
    (name.startsWith('VITE_') ? process.env[name.replace(/^VITE_/, '')] : undefined);
  if (value === undefined || value === '') {
    console.error(`❌ env wajib: ${name}`);
    process.exit(2);
  }
  return value;
}

const REF = requiredEnv('SUPABASE_PROJECT_REF');
const TOKEN = requiredEnv('SUPABASE_ACCESS_TOKEN');
const URL_ = requiredEnv('VITE_SUPABASE_URL');
const ANON = requiredEnv('VITE_SUPABASE_ANON_KEY');
const SERVICE = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');

const mask = (v) => `${v.slice(0, 6)}…${v.slice(-4)} (${v.length} char)`;
console.log('=== P0-1 verify — preflight ===');
console.log(`project ref : ${REF}`);
console.log(`url         : ${URL_}`);
console.log(`mgmt token  : ${mask(TOKEN)}`);
console.log(`anon key    : ${mask(ANON)}`);
console.log(`service key : ${mask(SERVICE)}`);

const MIGRATIONS_DIR = new URL('../../supabase/migrations', import.meta.url).pathname;
const results = [];
function record(id, description, pass, evidence) {
  results.push({ id, description, pass, evidence });
  console.log(`${pass ? '✅' : '❌'} ${id} — ${description}`);
  if (evidence !== undefined) {
    console.log(`   bukti: ${typeof evidence === 'string' ? evidence : JSON.stringify(evidence)}`);
  }
}

// ============================================================
// Management API helpers
// ============================================================

async function mgmt(method, path, body) {
  const response = await fetch(`https://api.supabase.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: response.status, json };
}

// ============================================================
// (1) Apply migrasi 0016 + 0017 (idempoten — skip yang sudah applied)
// ============================================================

{
  const listed = await mgmt('GET', `/v1/projects/${REF}/database/migrations`);
  if (listed.status !== 200) {
    console.error(`❌ gagal list migrasi: HTTP ${listed.status}`, listed.json);
    process.exit(2);
  }
  const applied = new Set((listed.json ?? []).map((m) => m.name));
  for (const name of ['0016_room_registry', '0017_realtime_room_authorization']) {
    if (applied.has(name)) {
      console.log(`ℹ️  migrasi ${name} sudah applied — skip`);
      continue;
    }
    const file = readdirSync(MIGRATIONS_DIR).find((f) => f === `${name}.sql`);
    if (file === undefined) {
      console.error(`❌ file migrasi tidak ditemukan: ${name}.sql`);
      process.exit(2);
    }
    const query = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const res = await mgmt('POST', `/v1/projects/${REF}/database/migrations`, { query, name });
    // Kontrak sukses endpoint ini (Task 21): HTTP 200 + body array kosong.
    if (res.status !== 200 || !Array.isArray(res.json)) {
      console.error(`❌ apply ${name} gagal: HTTP ${res.status}`, res.json);
      process.exit(1);
    }
    console.log(`✅ migrasi ${name} applied (HTTP 200)`);
  }
}

// ============================================================
// (2) Realtime config — private_only=true (toggle "Allow public access" OFF)
// ============================================================

{
  const before = await mgmt('GET', `/v1/projects/${REF}/config/realtime`);
  if (before.status !== 200) {
    console.error(`❌ gagal baca config realtime: HTTP ${before.status}`, before.json);
    process.exit(2);
  }
  console.log(`ℹ️  config realtime (sebelum): private_only=${before.json?.private_only}`);

  if (before.json?.private_only !== true) {
    const patched = await mgmt('PATCH', `/v1/projects/${REF}/config/realtime`, {
      private_only: true,
    });
    if (patched.status !== 200 && patched.status !== 204) {
      console.error(`❌ PATCH config/realtime gagal: HTTP ${patched.status}`, patched.json);
      console.error(
        '   → token mungkin tanpa scope realtime_config_write. ' +
          'Lakukan MANUAL: Dashboard → Realtime → Settings → matikan "Allow public access", ' +
          'lalu jalankan ulang script ini.',
      );
      process.exit(2);
    }
    console.log('✅ PATCH private_only=true terkirim');
  }

  const after = await mgmt('GET', `/v1/projects/${REF}/config/realtime`);
  if (after.json?.private_only !== true) {
    console.error(`❌ private_only MASIH false setelah PATCH:`, after.json);
    process.exit(2);
  }
  console.log('✅ config realtime (sesudah): private_only=true — channel non-private MATI');
}

// ============================================================
// (2b) Captcha — nonaktifkan SEMENTARA untuk signin programatik.
// FAKTA TERKONFIRMASI 2026-09-29: proyek memakai Turnstile NYATA
// (security_captcha_enabled=true) — dummy token DITOLAK. Tanpa ini
// signin 3 user uji mustahil. Dipulihkan otomatis di SEMUA jalur
// keluar (restoreCaptcha di bawah) — termasuk kegagalan setup.
// ============================================================

let captchaWasEnabled = null;

async function restoreCaptcha() {
  if (captchaWasEnabled !== true) return;
  try {
    const on = await mgmt('PATCH', `/v1/projects/${REF}/config/auth`, {
      security_captcha_enabled: true,
    });
    const check = await mgmt('GET', `/v1/projects/${REF}/config/auth`);
    if (check.json?.security_captcha_enabled === true) {
      console.log('✅ captcha DIPULIHKAN (security_captcha_enabled=true) — keadaan semula');
    } else {
      console.error(
        `❌ GAGAL memulihkan captcha (HTTP ${on.status}) — ` +
          'PATCH MANUAL SEGERA: Dashboard → Authentication → Providers → Turnstile → enable.',
      );
    }
  } catch (error) {
    console.error(
      `❌ GAGAL memulihkan captcha: ${error?.message ?? error} — ` +
        'PATCH MANUAL SEGERA: Dashboard → Authentication → Providers → Turnstile → enable.',
    );
  }
}

{
  const cfg = await mgmt('GET', `/v1/projects/${REF}/config/auth`);
  if (cfg.status !== 200) {
    console.error(`❌ gagal baca config auth: HTTP ${cfg.status}`, cfg.json);
    process.exit(2);
  }
  captchaWasEnabled = cfg.json?.security_captcha_enabled === true;
  if (captchaWasEnabled) {
    const off = await mgmt('PATCH', `/v1/projects/${REF}/config/auth`, {
      security_captcha_enabled: false,
    });
    if (off.status !== 200 && off.status !== 204) {
      console.error(`❌ PATCH security_captcha_enabled=false gagal: HTTP ${off.status}`, off.json);
      process.exit(2);
    }
    console.log('ℹ️  captcha dinonaktifkan SEMENTARA — dipulihkan otomatis di akhir run');
  }
}

// ============================================================
// (3) User uji + signin
// ============================================================

const runStamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const testUsers = [
  { label: 'A-host', email: `p01a-${runStamp}@verify.goofy.test` },
  { label: 'B-attacker', email: `p01b-${runStamp}@verify.goofy.test` },
  { label: 'C-guest', email: `p01c-${runStamp}@verify.goofy.test` },
];
const PASSWORD = `P01!${crypto.randomUUID().replace(/-/g, '')}`;
// Captcha dinonaktifkan sementara oleh blok (2b) — nilai dummy ini
// hanya formalitas; Turnstile nyata akan menolaknya (terbukti 2026-09-29).
const TURNSTILE_DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

async function gotrue(path, body, auth = 'service') {
  const headers = {
    apikey: auth === 'service' ? SERVICE : ANON,
    'Content-Type': 'application/json',
  };
  if (auth === 'service') {
    headers.Authorization = `Bearer ${SERVICE}`;
  }
  const response = await fetch(`${URL_}/auth/v1${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: response.status, json };
}

async function signIn(user) {
  // FAKTA (GoTrue v2.197.0 api/token.go:42, diverifikasi 2026-09-29):
  // grant_type dibaca dari QUERY STRING (r.FormValue) — persis cara
  // auth-js memanggil `/token?grant_type=password`; body tetap JSON.
  // Fallback token_hash lama DIHAPUS: token_hash bukan grant yang sah
  // (switch GoTrue hanya password|refresh_token|id_token|pkce|web3).
  // Captcha sudah dinonaktifkan sementara oleh blok (2b) — PATCH config
  // memerlukan beberapa detik untuk dipropagasikan, jadi retry backoff.
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const byPassword = await gotrue(
      '/token?grant_type=password',
      {
        email: user.email,
        password: PASSWORD,
        gotrue_meta_security: { captcha_token: TURNSTILE_DUMMY_TOKEN },
      },
      'anon',
    );
    if (byPassword.status === 200 && byPassword.json?.access_token) {
      if (attempt > 1) {
        console.log(`   (signin ${user.email} lolos pada percobaan ${attempt})`);
      }
      return {
        access_token: byPassword.json.access_token,
        refresh_token: byPassword.json.refresh_token,
        via: 'password',
      };
    }
    const code = byPassword.json?.error_code ?? `http_${byPassword.status}`;
    if (code === 'captcha_failed' && attempt < 8) {
      console.log(
        `   (captcha masih enforced utk ${user.email} — tunggu propagasi config, percobaan ${attempt}/8)`,
      );
      await new Promise((resolve) => setTimeout(resolve, 3000));
      continue;
    }
    throw new Error(
      `signin ${user.email} gagal: HTTP ${byPassword.status} ${JSON.stringify(byPassword.json).slice(0, 200)}`,
    );
  }
  throw new Error(`signin ${user.email}: retry habis (captcha tidak kunjung mati)`);
}

const sessions = {};
try {
  for (const user of testUsers) {
    const created = await gotrue('/admin/users', {
      email: user.email,
      password: PASSWORD,
      email_confirm: true,
    });
    if (created.status !== 200 || typeof created.json?.id !== 'string') {
      throw new Error(
        `buat user ${user.email} gagal: HTTP ${created.status} ${JSON.stringify(created.json).slice(0, 200)}`,
      );
    }
    user.id = created.json.id;
    const session = await signIn(user);
    sessions[user.label] = session;
    console.log(`✅ user uji ${user.label}: ${user.email} (signin via ${session.via})`);
  }
} catch (error) {
  console.error(`❌ setup user uji gagal: ${error.message}`);
  // Audit 23-c MEDIUM-1: jangan bocorkan user uji yang SUDAH berhasil dibuat
  // saat signin user berikutnya gagal (pola "user yatim" run 2 — 22-e,
  // dulu dibersihkan manual). Hapus dulu, baru pulihkan captcha, baru exit.
  for (const user of testUsers) {
    if (user.id === undefined) continue;
    try {
      const response = await fetch(`${URL_}/auth/v1/admin/users/${user.id}`, {
        method: 'DELETE',
        headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
      });
      console.log(`hapus user uji (setup-gagal) ${user.label}: HTTP ${response.status}`);
    } catch (cleanupError) {
      console.log(
        `hapus user ${user.label} gagal: ${cleanupError?.message ?? cleanupError} — ` +
          'HAPUS MANUAL: Dashboard → Authentication → Users → @verify.goofy.test',
      );
    }
  }
  await restoreCaptcha();
  process.exit(2);
}

async function clientFor(label) {
  const session = sessions[label];
  // DUA lapis anti-race (akar masalah run 4: rpc create_room berangkat
  // sebagai ANON — "permission denied for function"):
  // (1) global.headers.Authorization diletakkan DI CONSTRUCTION TIME —
  //     fetchWithAuth (supabase-js/src/lib/fetch.ts:90) MENGHORMATI
  //     Authorization yang sudah ada dan tidak menimpanya fallback anon;
  // (2) setSession DI-AWAIT — Realtime private channel mengambil token
  //     lewat accessToken factory (auth.getSession), yang membutuhkan
  //     sesi tersimpan dulu.
  const client = createClient(URL_, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${session.access_token}` } },
  });
  await client.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
  return client;
}

// Audit 23-c MEDIUM-2: pembuatan klien DIPINDAH ke dalam try utama (lihat
// bawah) — exception di jendela ini (sebelumnya di antara setup dan matriks)
// dulu melewati finally: 3 user yatim + captcha tertinggal OFF di cloud.
// (clientB/clientAnon tanpa initializer — selalu di-assign sebelum dibaca;
// clientA/clientC ber-init null karena dibaca di jalur finally.)
let clientA = null;
let clientB;
let clientC = null;
let clientAnon;

// ============================================================
// Helper subscribe dengan timeout (resolve pada status terminal pertama)
// ============================================================

function subscribeOnce(channel, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ status: 'TIMEOUT', err: null });
      }
    }, timeoutMs);
    channel.subscribe((status, err) => {
      if (settled) return;
      if (
        status === 'SUBSCRIBED' ||
        status === 'CHANNEL_ERROR' ||
        status === 'TIMED_OUT' ||
        status === 'CLOSED'
      ) {
        settled = true;
        clearTimeout(timer);
        resolve({ status, err });
      }
    });
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================
// Matriks pengujian
// ============================================================

let roomCode = null;
let channelA = null;
let channelC = null;
let presenceSeenByA = false;

try {
  clientA = await clientFor('A-host');
  clientB = await clientFor('B-attacker');
  clientC = await clientFor('C-guest');
  clientAnon = createClient(URL_, ANON, { auth: { persistSession: false } });

  // T1 — host: create_room.
  {
    const { data, error } = await clientA.rpc('create_room');
    const pass = error === null && typeof data === 'string' && /^[0-9A-HJKMNP-TV-Z]{8}$/.test(data);
    roomCode = pass ? data : null;
    record('T1', 'A create_room() → kode Crockford-32 8 karakter', pass, {
      error: error?.message ?? null,
      code: data ?? null,
    });
    if (!pass) throw new Error('T1 gagal — hentikan (tanpa kode tidak ada yang bisa diuji)');
  }

  const topic = `room:${roomCode}`;

  // T2 — A subscribe channel PRIVATE (regresi jalur sah).
  {
    channelA = clientA.channel(topic, { config: { private: true, presence: { key: 'p01-A' } } });
    channelA.on('presence', { event: 'sync' }, () => {
      const state = channelA.presenceState();
      if (Object.keys(state).includes('p01-C')) presenceSeenByA = true;
    });
    const result = await subscribeOnce(channelA);
    record(
      'T2',
      'A (host, peserta sah) subscribe channel PRIVATE → SUBSCRIBED',
      result.status === 'SUBSCRIBED',
      { status: result.status, err: result.err?.message ?? null },
    );
  }

  // T3 — A track presence.
  {
    const tracked = await channelA.track({ who: 'A' });
    record('T3', "A track presence → 'ok'", tracked === 'ok', { tracked });
  }

  // T4 — B (authenticated, TANPA tiket) subscribe → HARUS ditolak.
  {
    const channelB = clientB.channel(topic, { config: { private: true } });
    const result = await subscribeOnce(channelB);
    const denied =
      result.status !== 'SUBSCRIBED' &&
      /unauthorized|permission|denied/i.test(`${result.err?.message ?? ''}`);
    record(
      'T4',
      'B (TANPA tiket kepesertaan) subscribe → DITOLAK "Unauthorized" — kebocoran IP TERTUTUP',
      denied,
      { status: result.status, err: result.err?.message ?? null },
    );
    try {
      await clientB.removeChannel(channelB);
    } catch {
      // best-effort
    }
  }

  // T5 — anon (tanpa sesi) subscribe → ditolak.
  {
    const channelAnon = clientAnon.channel(topic, { config: { private: true } });
    const result = await subscribeOnce(channelAnon);
    // Audit 23-c LOW-1: TIMEOUT/TIMED_OUT TIDAK dihitung sebagai "ditolak"
    // (false-positive pada gerbang verifikasi keamanan saat jaringan flaky).
    const denied =
      result.status !== 'SUBSCRIBED' &&
      result.status !== 'TIMEOUT' &&
      result.status !== 'TIMED_OUT';
    record(
      'T5',
      'anon (tanpa sesi) subscribe → ditolak (bukan SUBSCRIBED, bukan timeout)',
      denied,
      { status: result.status, err: result.err?.message ?? null },
    );
    try {
      await clientAnon.removeChannel(channelAnon);
    } catch {
      // best-effort
    }
  }

  // T6 — B join format salah.
  // Kontrak 0016: kegagalan tercatat kembali sebagai DATA token (bukan error
  // PostgREST) supaya catatan percobaan COMMIT — lihat header 0016.
  {
    const { data, error } = await clientB.rpc('join_room', { p_code: 'pendek' });
    record(
      'T6',
      'B join_room format salah → INVALID_ROOM_CODE (token data)',
      data === 'INVALID_ROOM_CODE' && error === null,
      {
        data,
        error: error?.message ?? null,
      },
    );
  }

  // T7 — B brute-force 12 percobaan → kena RATE_LIMITED (server-side).
  {
    let rateLimited = 0;
    let notFound = 0;
    const seen = [];
    for (let i = 0; i < 12; i += 1) {
      const { data, error } = await clientB.rpc('join_room', { p_code: 'ZZZZZZ99' });
      const message = error !== null ? `ERR:${error.message}` : String(data);
      seen.push(message);
      if (message === 'ROOM_NOT_FOUND') notFound += 1;
      if (message === 'RATE_LIMITED') rateLimited += 1;
    }
    record(
      'T7',
      'B brute-force 12 percobaan join → DITOLAK RATE_LIMITED oleh database',
      rateLimited >= 1 && notFound >= 1,
      { notFound, rateLimited, sequence: seen },
    );
  }

  // T8 — C (tamu sah): join + subscribe + MENERIMA broadcast A (regresi e2e).
  {
    const { data, error } = await clientC.rpc('join_room', {
      p_code: ` ${roomCode.toLowerCase()} `,
    });
    const joinOk = error === null && data === 'OK';
    channelC = clientC.channel(topic, { config: { private: true, presence: { key: 'p01-C' } } });
    const received = [];
    channelC.on('broadcast', { event: 'signal' }, (message) => {
      received.push(message?.payload ?? message);
    });
    const result = await subscribeOnce(channelC);
    const tracked = result.status === 'SUBSCRIBED' ? await channelC.track({ who: 'C' }) : 'n/a';
    // A mengirim 3 broadcast — C harus menerima semuanya (bukti jalur tulis
    // INSERT policy + jalur baca SELECT policy + relaying server).
    if (result.status === 'SUBSCRIBED') {
      for (let i = 0; i < 3; i += 1) {
        await channelA.send({
          type: 'broadcast',
          event: 'signal',
          payload: {
            v: 1,
            type: 'offer',
            from: 'p01-A',
            to: 'p01-C',
            sdp: `v=0\r\np01-probe-${i}`,
          },
        });
      }
      for (let i = 0; i < 30 && received.length < 3; i += 1) {
        await wait(500);
      }
    }
    const presenceOk = await (async () => {
      for (let i = 0; i < 20 && !presenceSeenByA; i += 1) {
        await wait(500);
      }
      return presenceSeenByA;
    })();
    record(
      'T8',
      'C join (input kotor) + subscribe + MENERIMA 3 broadcast A + presence terlihat A — signaling REGRESI OK',
      joinOk &&
        result.status === 'SUBSCRIBED' &&
        tracked === 'ok' &&
        received.length === 3 &&
        presenceOk,
      {
        joinData: data ?? null,
        joinError: error?.message ?? null,
        subscribeStatus: result.status,
        tracked,
        broadcastsReceived: received.length,
        receivedPayloads: received.map((r) => r?.sdp ?? null),
        presenceSeenByA,
      },
    );
  }

  // T9 — bypass "tanpa flag private" → ditolak (PrivateOnly) — bukti toggle.
  {
    const channelNoFlag = clientA.channel('room:BYPASS01', { config: {} });
    const result = await subscribeOnce(channelNoFlag);
    // Audit 23-c LOW-1: sama seperti T5 — timeout ambigu TIDAK boleh dihitung
    // sebagai bukti penolakan.
    const denied =
      result.status !== 'SUBSCRIBED' &&
      result.status !== 'TIMEOUT' &&
      result.status !== 'TIMED_OUT';
    record(
      'T9',
      'A subscribe channel TANPA flag private → DITOLAK (private_only aktif — jalur bypass mati)',
      denied,
      { status: result.status, err: result.err?.message ?? null },
    );
    try {
      await clientA.removeChannel(channelNoFlag);
    } catch {
      // best-effort
    }
  }

  // (5) Bukti state via SQL read-only.
  {
    const policyRows = await mgmt('POST', `/v1/projects/${REF}/database/query`, {
      query: `select policyname, cmd from pg_policies where schemaname = 'realtime' and tablename = 'messages' order by policyname`,
    });
    const roomRow = await mgmt('POST', `/v1/projects/${REF}/database/query`, {
      query: `select code, max_participants, (select count(*) from public.room_participants p where p.room_code = r.code) as participants from public.rooms r where r.code = '${roomCode}'`,
    });
    console.log('\n=== Bukti SQL (read-only) ===');
    console.log('realtime.messages policies:', JSON.stringify(policyRows.json));
    console.log('room row:', JSON.stringify(roomRow.json));
    const policiesOk =
      policyRows.status === 201 &&
      Array.isArray(policyRows.json) &&
      policyRows.json.some((p) => p.cmd === 'SELECT') &&
      policyRows.json.some((p) => p.cmd === 'INSERT');
    record(
      'T10',
      'policy realtime.messages SELECT+INSERT terpasang di cloud + baris room tercatat',
      policiesOk &&
        roomRow.status === 201 &&
        Array.isArray(roomRow.json) &&
        roomRow.json.length === 1 &&
        roomRow.json[0].participants >= 2,
      { policies: policyRows.json, room: roomRow.json },
    );
  }
} finally {
  // (6) Cleanup — best effort, jangan pernah lempar.
  console.log('\n=== Cleanup ===');
  for (const [client, channel] of [
    [clientA, channelA],
    [clientC, channelC],
  ]) {
    if (channel !== null && channel !== undefined) {
      try {
        await client.removeChannel(channel);
      } catch {
        // best-effort
      }
    }
  }
  if (roomCode !== null) {
    try {
      await clientA.rpc('leave_room', { p_code: roomCode });
      await clientC.rpc('leave_room', { p_code: roomCode });
      console.log('leave_room A & C ok');
    } catch (error) {
      console.log(`leave_room gagal (TTL 1 jam akan membersihkan): ${error?.message ?? error}`);
    }
  }
  for (const user of testUsers) {
    if (user.id === undefined) continue;
    try {
      const response = await fetch(`${URL_}/auth/v1/admin/users/${user.id}`, {
        method: 'DELETE',
        headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
      });
      console.log(
        `hapus user uji ${user.label}: HTTP ${response.status} (CASCADE rooms/participants/attempts)`,
      );
    } catch (error) {
      console.log(`hapus user ${user.label} gagal: ${error?.message ?? error}`);
    }
  }
  await restoreCaptcha();
}

// ============================================================
// Ringkasan
// ============================================================

const failed = results.filter((r) => !r.pass);
console.log('\n================ RINGKASAN P0-1 ================');
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id} — ${r.description}`);
}
console.log(`================================================`);
if (failed.length > 0) {
  console.log(`❌ ${failed.length} tes GAGAL — P0-1 BELUM lolos verifikasi cloud.`);
  process.exit(1);
}
console.log('✅ SEMUA tes P0-1 lolos pada cloud.');
process.exit(0);
