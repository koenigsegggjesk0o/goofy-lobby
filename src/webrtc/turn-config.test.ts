import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ICE_SERVERS, type PeerConnectionManagerOptions } from './peer-connection-manager';
import {
  EPHEMERAL_TURN_RENEW_MARGIN_MS,
  TURN_USERNAME_MAX_LENGTH,
  clearEphemeralTurnCache,
  parseTurnEnv,
  readTurnEnvFromVite,
  resolveEphemeralTurn,
  resolveIceServers,
} from './turn-config';

/**
 * Fixture dummy yang JELAS bukan kredensial nyata (aturan proyek: tidak ada
 * nilai kredensial mock/nyata di kode ter-commit) — hanya penanda string
 * supaya entri TURN bisa dikenali di asersi.
 */
const DUMMY_USERNAME = 'dummy-username';
const DUMMY_CREDENTIAL = 'dummy-credential';
const TURN_URL = 'turn:standard.relay.metered.ca:80';

const validSource: Record<string, string | undefined> = {
  VITE_TURN_URL: TURN_URL,
  VITE_TURN_USERNAME: DUMMY_USERNAME,
  VITE_TURN_CREDENTIAL: DUMMY_CREDENTIAL,
};

const expectedTurnEntry = {
  urls: [TURN_URL],
  username: DUMMY_USERNAME,
  credential: DUMMY_CREDENTIAL,
};

describe('parseTurnEnv', () => {
  it('disabled saat source kosong', () => {
    expect(parseTurnEnv({})).toEqual({ status: 'disabled' });
  });

  it('disabled saat semua variabel TURN kosong / whitespace / undefined', () => {
    expect(
      parseTurnEnv({
        VITE_TURN_URL: '   ',
        VITE_TURN_USERNAME: '',
        VITE_TURN_CREDENTIAL: ' \t ',
      }),
    ).toEqual({ status: 'disabled' });
    expect(
      parseTurnEnv({
        VITE_TURN_URL: undefined,
        VITE_TURN_USERNAME: undefined,
        VITE_TURN_CREDENTIAL: undefined,
      }),
    ).toEqual({ status: 'disabled' });
  });

  it('variabel env lain (non-TURN) tidak mengubah status disabled', () => {
    expect(
      parseTurnEnv({
        VITE_SUPABASE_URL: 'https://example.supabase.co',
        VITE_SENTRY_DSN: 'https://example@sentry.example.com/1',
      }),
    ).toEqual({ status: 'disabled' });
  });

  it('enabled: URL tunggal → entri TURN + default STUN', () => {
    const result = parseTurnEnv(validSource);
    expect(result).toEqual({
      status: 'enabled',
      iceServers: [...DEFAULT_ICE_SERVERS, expectedTurnEntry],
    });
  });

  it('enabled: beberapa URL dipisah koma (dengan spasi) → satu entri, urls array', () => {
    const result = parseTurnEnv({
      ...validSource,
      VITE_TURN_URL:
        'turns:standard.relay.metered.ca:443?transport=tcp,  turn:standard.relay.metered.ca:80  , , turn:standard.relay.metered.ca:80?transport=udp',
    });
    expect(result.status).toBe('enabled');
    if (result.status !== 'enabled') return;
    expect(result.iceServers).toEqual([
      ...DEFAULT_ICE_SERVERS,
      {
        urls: [
          'turns:standard.relay.metered.ca:443?transport=tcp',
          'turn:standard.relay.metered.ca:80',
          'turn:standard.relay.metered.ca:80?transport=udp',
        ],
        username: DUMMY_USERNAME,
        credential: DUMMY_CREDENTIAL,
      },
    ]);
  });

  it('enabled: username tepat di batas maksimum tetap diterima', () => {
    const result = parseTurnEnv({
      ...validSource,
      VITE_TURN_USERNAME: 'a'.repeat(TURN_USERNAME_MAX_LENGTH),
    });
    expect(result.status).toBe('enabled');
  });

  it('trim whitespace pada semua input', () => {
    const result = parseTurnEnv({
      VITE_TURN_URL: `  ${TURN_URL}  `,
      VITE_TURN_USERNAME: `  ${DUMMY_USERNAME}  `,
      VITE_TURN_CREDENTIAL: ` ${DUMMY_CREDENTIAL} `,
    });
    expect(result).toEqual({
      status: 'enabled',
      iceServers: [...DEFAULT_ICE_SERVERS, expectedTurnEntry],
    });
  });

  it('hasil enabled tidak berbagi referensi mutable dengan DEFAULT_ICE_SERVERS', () => {
    const result = parseTurnEnv(validSource);
    expect(result.status).toBe('enabled');
    if (result.status !== 'enabled') return;
    expect(result.iceServers).not.toBe(DEFAULT_ICE_SERVERS);
    expect(result.iceServers[0]).not.toBe(DEFAULT_ICE_SERVERS[0]);
    expect(result.iceServers[0]?.urls).not.toBe(DEFAULT_ICE_SERVERS[0]?.urls);
  });

  it('invalid: skema salah (http:, stun:) → alasan menyebut nilai bermasalah', () => {
    const result = parseTurnEnv({
      ...validSource,
      VITE_TURN_URL: 'http://relay.example.com:80,stun:stun.example.com:3478',
    });
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(result.reasons).toHaveLength(2);
    expect(result.reasons.some((r) => r.includes('http://relay.example.com:80'))).toBe(true);
    expect(result.reasons.some((r) => r.includes('stun:stun.example.com:3478'))).toBe(true);
  });

  it('invalid: URL hanya koma/spasi → tidak ada URL tersisa', () => {
    const result = parseTurnEnv({ ...validSource, VITE_TURN_URL: ' , , ' });
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toContain('VITE_TURN_URL');
  });

  it('invalid: URL terisi tanpa username', () => {
    const result = parseTurnEnv({
      VITE_TURN_URL: TURN_URL,
      VITE_TURN_CREDENTIAL: DUMMY_CREDENTIAL,
    });
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toContain('VITE_TURN_USERNAME');
  });

  it('invalid: URL terisi tanpa credential', () => {
    const result = parseTurnEnv({
      VITE_TURN_URL: TURN_URL,
      VITE_TURN_USERNAME: DUMMY_USERNAME,
    });
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toContain('VITE_TURN_CREDENTIAL');
  });

  it('invalid: username + credential tanpa URL', () => {
    const result = parseTurnEnv({
      VITE_TURN_USERNAME: DUMMY_USERNAME,
      VITE_TURN_CREDENTIAL: DUMMY_CREDENTIAL,
    });
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toContain('VITE_TURN_URL');
  });

  it('invalid: SEMUA masalah terkumpul sekaligus, bukan cuma yang pertama', () => {
    const result = parseTurnEnv({
      VITE_TURN_URL: 'http://bad.example.com:80,stun:stun.bad.example.com:3478',
    });
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(result.reasons).toHaveLength(4);
    expect(result.reasons.some((r) => r.includes('http://bad.example.com:80'))).toBe(true);
    expect(result.reasons.some((r) => r.includes('stun:stun.bad.example.com:3478'))).toBe(true);
    expect(result.reasons.some((r) => r.includes('VITE_TURN_USERNAME'))).toBe(true);
    expect(result.reasons.some((r) => r.includes('VITE_TURN_CREDENTIAL'))).toBe(true);
  });

  it('invalid: username melebihi panjang maksimum', () => {
    const result = parseTurnEnv({
      ...validSource,
      VITE_TURN_USERNAME: 'a'.repeat(TURN_USERNAME_MAX_LENGTH + 1),
    });
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toContain('VITE_TURN_USERNAME');
    expect(result.reasons[0]).toContain(String(TURN_USERNAME_MAX_LENGTH));
  });
});

describe('resolveIceServers', () => {
  it('disabled → STUN-only, deep-equal DEFAULT_ICE_SERVERS, tanpa reasons', () => {
    expect(resolveIceServers({})).toEqual({
      iceServers: DEFAULT_ICE_SERVERS,
      turnStatus: 'disabled',
    });
  });

  it('enabled → memuat entri TURN setelah default STUN', () => {
    const resolved = resolveIceServers(validSource);
    expect(resolved).toEqual({
      iceServers: [...DEFAULT_ICE_SERVERS, expectedTurnEntry],
      turnStatus: 'enabled',
    });
  });

  it('invalid → fallback STUN-only + reasons tersampaikan (tidak ditelan)', () => {
    const resolved = resolveIceServers({ VITE_TURN_URL: TURN_URL });
    expect(resolved.turnStatus).toBe('invalid');
    expect(resolved.iceServers).toEqual(DEFAULT_ICE_SERVERS);
    expect(resolved.reasons).toBeDefined();
    expect(resolved.reasons?.some((r) => r.includes('VITE_TURN_USERNAME'))).toBe(true);
  });

  it('iceServers hasil enabled assignable ke tipe opsi PeerConnectionManager (type-level)', () => {
    const parsed = parseTurnEnv(validSource);
    expect(parsed.status).toBe('enabled');
    if (parsed.status !== 'enabled') return;
    // Bukti type-level: bentuk hasil cocok dengan options.iceServers manager.
    const options: Pick<PeerConnectionManagerOptions, 'iceServers'> = {
      iceServers: parsed.iceServers,
    };
    const fromResolve: PeerConnectionManagerOptions['iceServers'] =
      resolveIceServers(validSource).iceServers;
    expect(options.iceServers).toEqual([...DEFAULT_ICE_SERVERS, expectedTurnEntry]);
    expect(fromResolve).toEqual(options.iceServers);
  });
});

describe('readTurnEnvFromVite / argumen default import.meta.env', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('source eksplisit dipakai apa adanya (pola injeksi env.ts)', () => {
    expect(readTurnEnvFromVite({})).toEqual({ status: 'disabled' });
    expect(readTurnEnvFromVite(validSource).status).toBe('enabled');
  });

  it('tanpa argumen membaca import.meta.env (via stub vitest)', () => {
    vi.stubEnv('VITE_TURN_URL', `  ${TURN_URL}  `);
    vi.stubEnv('VITE_TURN_USERNAME', DUMMY_USERNAME);
    vi.stubEnv('VITE_TURN_CREDENTIAL', DUMMY_CREDENTIAL);
    expect(readTurnEnvFromVite()).toEqual({
      status: 'enabled',
      iceServers: [...DEFAULT_ICE_SERVERS, expectedTurnEntry],
    });
  });

  it('resolveIceServers tanpa argumen juga membaca import.meta.env', () => {
    vi.stubEnv('VITE_TURN_URL', TURN_URL);
    vi.stubEnv('VITE_TURN_USERNAME', DUMMY_USERNAME);
    vi.stubEnv('VITE_TURN_CREDENTIAL', DUMMY_CREDENTIAL);
    const resolved = resolveIceServers();
    expect(resolved.turnStatus).toBe('enabled');
    expect(resolved.iceServers).toEqual([...DEFAULT_ICE_SERVERS, expectedTurnEntry]);
  });
});

// ============================================================
// resolveEphemeralTurn (remediasi audit 25-c H2) — fetch + cache + fallback
// ============================================================

describe('resolveEphemeralTurn', () => {
  /** Jam terkontrol (millisecond epoch) supaya tes cache deterministik. */
  let fakeNow = 1_000_000_000_000;
  const tick = (ms: number) => {
    fakeNow += ms;
  };

  /** Payload ephemeral sah — expiresAt 1 jam dari fakeNow. */
  const validPayload = () => ({
    urls: [TURN_URL],
    username: DUMMY_USERNAME,
    credential: DUMMY_CREDENTIAL,
    expiresAt: fakeNow + 3_600_000,
  });

  const jsonOk = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  const makeArgs = (fetchImpl: typeof fetch) => ({
    url: 'https://edge.example/functions/v1/turn-credentials',
    getAccessToken: async () => 'fake-jwt-token',
    fetchImpl,
    now: () => fakeNow,
  });

  afterEach(() => {
    clearEphemeralTurnCache();
    fakeNow = 1_000_000_000_000;
    vi.restoreAllMocks();
  });

  it('payload sah → entri RTCIceServer + header Authorization Bearer terpasang', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input; // posisi pertama tanda tangan fetch; tidak dibaca test ini
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer fake-jwt-token');
      return jsonOk(validPayload());
    }) as unknown as typeof fetch;
    const entry = await resolveEphemeralTurn(makeArgs(fetchImpl));
    expect(entry).toEqual({
      urls: [TURN_URL],
      username: DUMMY_USERNAME,
      credential: DUMMY_CREDENTIAL,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('cache sehat → fetch TIDAK dipanggil ulang; lewat margin → refresh', async () => {
    const fetchImpl = vi.fn(async () => jsonOk(validPayload())) as unknown as typeof fetch;
    const args = makeArgs(fetchImpl);
    await resolveEphemeralTurn(args);
    await resolveEphemeralTurn(args);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // masih jauh dari kedaluwarsa
    // Maju hingga LEBIH dari (expiresAt - 60s margin) → wajib fetch ulang.
    tick(3_600_000 - EPHEMERAL_TURN_RENEW_MARGIN_MS + 1);
    await resolveEphemeralTurn(args);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('cache tidak dipakai lintas URL layanan berbeda', async () => {
    const fetchImpl = vi.fn(async () => jsonOk(validPayload())) as unknown as typeof fetch;
    const args = makeArgs(fetchImpl);
    await resolveEphemeralTurn(args);
    const other = { ...args, url: 'https://other.example/fn' };
    await resolveEphemeralTurn(other);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('non-200 → null (fallback statis di pemanggil)', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('nope', { status: 503 }),
    ) as unknown as typeof fetch;
    await expect(resolveEphemeralTurn(makeArgs(fetchImpl))).resolves.toBeNull();
  });

  it('fetch melempar → null; getAccessToken melempar → null; token kosong → null', async () => {
    const throwing = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    await expect(resolveEphemeralTurn(makeArgs(throwing))).resolves.toBeNull();
    await expect(
      resolveEphemeralTurn({
        ...makeArgs(vi.fn() as unknown as typeof fetch),
        getAccessToken: async () => {
          throw new Error('no session');
        },
      }),
    ).resolves.toBeNull();
    await expect(
      resolveEphemeralTurn({
        ...makeArgs(vi.fn() as unknown as typeof fetch),
        getAccessToken: async () => '',
      }),
    ).resolves.toBeNull();
  });

  it('payload rusak / skema gugur / sudah kedaluwarsa → null + onInvalid terpanggil', async () => {
    const reasons: string[] = [];
    const report = (reason: string) => reasons.push(reason);
    const notJson = vi.fn(
      async () => new Response('<html>', { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(
      resolveEphemeralTurn({ ...makeArgs(notJson), onInvalid: report }),
    ).resolves.toBeNull();
    const badSchema = vi.fn(async () =>
      jsonOk({ urls: [], username: '', credential: 'x', expiresAt: 1 }),
    ) as unknown as typeof fetch;
    await expect(
      resolveEphemeralTurn({ ...makeArgs(badSchema), onInvalid: report }),
    ).resolves.toBeNull();
    const stale = vi.fn(async () =>
      jsonOk({ ...validPayload(), expiresAt: fakeNow - 1 }),
    ) as unknown as typeof fetch;
    await expect(
      resolveEphemeralTurn({ ...makeArgs(stale), onInvalid: report }),
    ).resolves.toBeNull();
    expect(reasons).toHaveLength(3);
    expect(reasons.every((r) => r.length > 0)).toBe(true);
  });

  it('kegagalan TIDAK menular ke cache — pemanggilan berikutnya tetap mencoba fetch', async () => {
    let fail = true;
    const fetchImpl = vi.fn(async () =>
      fail ? new Response('err', { status: 500 }) : jsonOk(validPayload()),
    ) as unknown as typeof fetch;
    await expect(resolveEphemeralTurn(makeArgs(fetchImpl))).resolves.toBeNull();
    fail = false;
    await expect(resolveEphemeralTurn(makeArgs(fetchImpl))).resolves.toMatchObject({
      username: DUMMY_USERNAME,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
