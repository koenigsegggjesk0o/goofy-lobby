// ============================================================================
// supabase/functions/turn-credentials/index.ts — Edge Function Deno
// ============================================================================
// MODE REST CLOUDFLARE (dipilih user, 30 Sep 2026): kredensial ephemeral
// TIDAK dihitung lokal, melainkan di-mint oleh API Cloudflare Calls TURN
//   POST https://rtc.live.cloudflare.com/v1/turn/keys/{KEY_ID}/credentials/generate-ice-servers
//   Authorization: Bearer {TURN_API_TOKEN}   body: {"ttl": 3600}
//   → {"iceServers":[{"urls":[stun/turn/turns...],"username":"<epoch-detik>","credential":"..."}]}
//
// Secret (supabase secrets — JANGAN hardcode di file):
//   TURN_KEY_ID     = Cloudflare → Calls/TURN → App "goofy ah chat" → Key ID
//   TURN_API_TOKEN  = token API akun Cloudflare (scope TURN Edit)
//   TURN_TTL_SECONDS (opsional, default 3600, clamp 300..86400)
// SUPABASE_URL + SUPABASE_ANON_KEY di-inject otomatis platform saat deploy.
//
// Kontrak respons — PERSIS skema klien EphemeralTurnResponseSchema
// (src/webrtc/turn-config.ts): {urls, username, credential, expiresAt(ms)}.
// Username Cloudflare = epoch-detik kedaluwarsa → expiresAt = username*1000.
//
// Nol dependensi eksternal (murni Web API Deno) supaya bisa dideploy via
// Management API tanpa import map. Verifikasi pemanggil: Bearer JWT sah
// dicek ke {SUPABASE_URL}/auth/v1/user — menolak anon key (role anon)
// sekaligus token kedaluwarsa; ini inti remediasi audit 25-c HIGH H2
// (denial-of-wallet relay TURN).
// ============================================================================

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
  'Access-Control-Max-Age': '86400',
};

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // Kredensial pribadi + berumur pendek — jangan pernah di-cache perantara.
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
    },
  });
}

const DEFAULT_TTL_SECONDS = 3_600;
const MIN_TTL_SECONDS = 300;
const MAX_TTL_SECONDS = 86_400;

function clampTtl(raw: string | undefined): number {
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_TTL_SECONDS;
  return Math.min(Math.max(Math.trunc(parsed), MIN_TTL_SECONDS), MAX_TTL_SECONDS);
}

Deno.serve(async (req) => {
  // Preflight CORS (browser dari domain Vercel/preview).
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'GET') return json(405, { ok: false, reason: 'method-not-allowed' });
  try {
    const keyId = Deno.env.get('TURN_KEY_ID');
    const apiToken = Deno.env.get('TURN_API_TOKEN');
    if (keyId === undefined || keyId === '' || apiToken === undefined || apiToken === '') {
      return json(500, {
        ok: false,
        reason: 'setup',
        message:
          'TURN_KEY_ID / TURN_API_TOKEN belum diset — set secrets fungsi ini ' +
          '(supabase secrets set TURN_KEY_ID=... TURN_API_TOKEN=...)',
      });
    }

    // ── Verifikasi pemanggil: wajib JWT sesi user sah (bukan anon key) ──
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    if (supabaseUrl === '' || anonKey === '') {
      return json(500, { ok: false, reason: 'setup', message: 'SUPABASE_URL/ANON_KEY tidak ter-inject' });
    }
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    if (token === '') return json(401, { ok: false, reason: 'missing-bearer-token' });
    const who = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: anonKey },
    });
    if (!who.ok) {
      // 401 seragam — bukan orakel "format salah vs kedaluwarsa vs anon".
      return json(401, { ok: false, reason: 'invalid-token' });
    }
    const whoBody = (await who.json()) as { id?: string } | null;
    if (whoBody?.id === undefined) return json(401, { ok: false, reason: 'invalid-token' });

    // ── Mint kredensial ephemeral dari Cloudflare ──
    const ttl = clampTtl(Deno.env.get('TURN_TTL_SECONDS'));
    const cfRes = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl }),
      },
    );
    if (!cfRes.ok) {
      const detail = await cfRes.text().catch(() => '');
      console.error('[turn-credentials] cloudflare menolak:', cfRes.status, detail.slice(0, 300));
      return json(502, { ok: false, reason: 'upstream-rejected' });
    }
    const cf = (await cfRes.json()) as {
      iceServers?: Array<{ urls?: string[] | string; username?: string; credential?: string }>;
    };
    // Respons nyata Cloudflare: iceServers = [ {urls:[stun…]},
    // {urls:[turn/turns…], username, credential} ] — entri BERTENGAH kredensial
    // dipakai; urls STUN digabungkan (RTCIceServer.urls boleh campur).
    const urls: string[] = [];
    let username = '';
    let credential = '';
    for (const entry of cf.iceServers ?? []) {
      const entryUrls = Array.isArray(entry.urls) ? entry.urls : typeof entry.urls === 'string' ? [entry.urls] : [];
      urls.push(...entryUrls.filter((u) => u !== ''));
      if (entry.username !== undefined && entry.credential !== undefined) {
        username = entry.username;
        credential = entry.credential;
      }
    }
    if (urls.length === 0 || username === '' || credential === '') {
      return json(502, { ok: false, reason: 'upstream-malformed' });
    }
    // Username Cloudflare bentuknya hash opaq (bukan epoch) — kedaluwarsa
    // dihitung dari ttl yang kita minta.
    const expiresAt = Date.now() + ttl * 1000;

    // Log MINIM tanpa PII: uid saja (audit kuota relay per identitas).
    console.log('[turn-credentials] issued', { uid: whoBody.id, ttl, urls: urls.length });
    return json(200, { ok: true, urls, username, credential, expiresAt });
  } catch (error) {
    console.error('[turn-credentials] gagal:', error);
    return json(500, { ok: false, reason: 'credentials-failed' });
  }
});
