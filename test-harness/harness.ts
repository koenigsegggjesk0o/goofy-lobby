/**
 * TEST HARNESS F1.6 — alat uji otomatis, BUKAN UI produk.
 *
 * Mengekspos `window.__harness` untuk Playwright e2e (e2e/*.spec.ts) dan
 * pemakaian manual lewat devtools. Setiap method defensif: tidak pernah
 * melempar ke pemanggil — hasil selalu objek plain serializable-JSON
 * (syarat page.evaluate) dengan bidang `ok` + detail kegagalan.
 *
 * Kelompok kemampuan:
 *  - env/auth    : envStatus (termasuk status TURN), signUp (probe
 *                  penolakan captcha), signIn, signOut, getSession,
 *                  probeListProfiles
 *  - profil      : getProfile, updateProfile, probeReadProfile,
 *                  probeWriteProfile (matriks RLS ringan)
 *  - snippet     : recordMockSnippet (stream sintetis → MediaRecorder asli),
 *                  uploadLastRecording, createPlaybackUrl, fetchSnippet,
 *                  listSnippets, clearSnippet, cleanupSnippets,
 *                  probeUploadToFolder (RLS storage lintas user)
 *  - monitoring  : initMonitoringLive, captureTestError, flushMonitoringLive,
 *                  monitoringStatusLive, verifySentryIngest (probe POST ke
 *                  endpoint ingest — bukti keras diterima server Sentry)
 *  - mesh        : joinMesh, leaveMesh, meshState, setLocalPosition,
 *                  meshLog (presence + signaling + P2P dua konteks)
 *  - audio       : audioSmoke (engine spasial + listener + panner di
 *                  AudioContext asli browser)
 *
 * Token captcha default = dummy resmi Turnstile (test key selalu lolos) —
 * konfigurasi Auth Supabase proyek ini memakai test key hingga Fase 3.
 */

import { readClientEnv } from '../src/lib/env';
import { getAppSupabase } from '../src/lib/supabase';
import {
  ProfileService,
  VoiceRecorder,
  VoiceSnippetManager,
  VoiceSnippetService,
  asProfileClient,
  type Profile,
  type ProfileUpdate,
  type VoiceRecordingResult,
} from '../src/profile';
import { SpatialAudioEngine } from '../src/audio';
import { captureError, flushMonitoring, initMonitoring, monitoringStatus } from '../src/monitoring';
import {
  MeshRoomController,
  readTurnEnvFromVite,
  resolveIceServers,
  type PeerState,
  type SessionInfo,
  type SupabaseRealtimeLike,
  type TurnEnvStatus,
} from '../src/webrtc';

// ============================================================
// Kontrak hasil (semua JSON-serializable untuk page.evaluate)
// ============================================================

interface ErrorDetail {
  message: string;
  code?: string;
  status?: number;
}

interface AuthProbeResult extends ErrorDetail {
  ok: boolean;
  userId: string | null;
}

interface SessionProbeResult {
  signedIn: boolean;
  userId: string | null;
  email: string | null;
}

interface ProfileResult extends ErrorDetail {
  ok: boolean;
  profile: Profile | null;
}

interface CountProbeResult extends ErrorDetail {
  ok: boolean;
  count: number;
}

interface ReadProbeResult extends ErrorDetail {
  ok: boolean;
  displayName: string | null;
}

interface WriteProbeResult extends ErrorDetail {
  ok: boolean;
  /** true bila baris benar-benar berubah (RLS gagal memblokir = false alarm). */
  changed: boolean;
}

interface ForeignUploadProbeResult extends ErrorDetail {
  ok: boolean;
  /** true bila upload DITOLAK (perilaku yang benar menurut RLS). */
  blocked: boolean;
}

interface RecordResult extends ErrorDetail {
  ok: boolean;
  bytes: number;
  durationMs: number;
  mimeType: string;
  autoStopped: 'duration' | 'byte-cap' | null;
  contextState: string;
}

interface UploadResult extends ErrorDetail {
  ok: boolean;
  path: string | null;
  fullPath: string | null;
  bytes: number;
  previousPath: string | null;
  previousDeleted: boolean;
}

interface PlaybackUrlResult extends ErrorDetail {
  ok: boolean;
  signedUrl: string | null;
  expiresInS: number | null;
}

interface FetchSnippetResult {
  ok: boolean;
  status: number | null;
  contentType: string | null;
  bytes: number;
  message: string;
}

interface ListResult extends ErrorDetail {
  ok: boolean;
  names: string[];
}

interface ClearResult extends ErrorDetail {
  ok: boolean;
  clearedPath: string | null;
}

interface CleanupResult extends ErrorDetail {
  ok: boolean;
  deleted: number;
  remaining: string[];
}

interface MonitoringInitResult extends ErrorDetail {
  ok: boolean;
  initialized: boolean;
  skipped: 'empty-dsn' | 'already-initialized' | null;
  hasDsn: boolean;
}

interface CaptureResult extends ErrorDetail {
  ok: boolean;
  eventId: string;
}

interface FlushResult extends ErrorDetail {
  ok: boolean;
  sent: boolean;
}

interface IngestResult {
  ok: boolean;
  status: number | null;
  eventId: string;
  message: string;
}

interface MeshJoinResult extends ErrorDetail {
  ok: boolean;
  sessionId: string | null;
  roomCode: string | null;
}

interface MeshLeaveResult extends ErrorDetail {
  ok: boolean;
}

interface MeshPeerSnapshot {
  sessionId: string;
  displayName: string;
  connectionState: string;
  iceConnectionState: string;
  lastPosition: { x: number; y: number } | null;
  lastPositionAt: number | null;
}

interface MeshStateResult {
  joined: boolean;
  roomCode: string | null;
  sessionId: string | null;
  self: { userId: string; displayName: string; avatarColor: string } | null;
  peers: MeshPeerSnapshot[];
}

interface MeshLogEntry {
  at: string;
  event: string;
  detail: Record<string, unknown>;
}

interface PositionResult extends ErrorDetail {
  ok: boolean;
}

interface AudioSmokeResult extends ErrorDetail {
  ok: boolean;
  contextState: string | null;
  peerVoiceIds: string[];
  peerPosition: { x: number; y: number } | null;
  muted: boolean | null;
  disposed: boolean;
}

/** Seluruh kemampuan harness (dipasang ke window.__harness). */
export interface HarnessApi {
  envStatus(): {
    ready: boolean;
    missing: string[];
    hasTurnstileKey: boolean;
    hasSentryDsn: boolean;
    turn: { status: TurnEnvStatus; reasons: string[] };
  };
  signUp(email: string, password: string, captchaToken?: string): Promise<AuthProbeResult>;
  signIn(email: string, password: string, captchaToken?: string): Promise<AuthProbeResult>;
  signOut(): Promise<ErrorDetail & { ok: boolean }>;
  getSession(): Promise<SessionProbeResult>;
  probeListProfiles(): Promise<CountProbeResult>;
  getProfile(userId?: string): Promise<ProfileResult>;
  updateProfile(patch: ProfileUpdate): Promise<ProfileResult>;
  probeReadProfile(userId: string): Promise<ReadProbeResult>;
  probeWriteProfile(userId: string, displayName: string): Promise<WriteProbeResult>;
  recordMockSnippet(durationMs?: number): Promise<RecordResult>;
  uploadLastRecording(): Promise<UploadResult>;
  createPlaybackUrl(path?: string): Promise<PlaybackUrlResult>;
  fetchSnippet(path?: string): Promise<FetchSnippetResult>;
  listSnippets(): Promise<ListResult>;
  clearSnippet(): Promise<ClearResult>;
  cleanupSnippets(): Promise<CleanupResult>;
  probeUploadToFolder(folderUserId: string): Promise<ForeignUploadProbeResult>;
  initMonitoringLive(): Promise<MonitoringInitResult>;
  captureTestError(label: string): Promise<CaptureResult>;
  flushMonitoringLive(timeoutMs?: number): Promise<FlushResult>;
  monitoringStatusLive(): { initialized: boolean; enabled: boolean };
  verifySentryIngest(): Promise<IngestResult>;
  joinMesh(
    roomCode: string,
    opts?: { displayName?: string; avatarColor?: string; attachMockStream?: boolean },
  ): Promise<MeshJoinResult>;
  leaveMesh(): Promise<MeshLeaveResult>;
  meshState(): MeshStateResult;
  setLocalPosition(x: number, y: number): PositionResult;
  meshLog(): MeshLogEntry[];
  audioSmoke(): Promise<AudioSmokeResult>;
}

declare global {
  interface Window {
    __harness: HarnessApi;
  }
}

// ============================================================
// Util
// ============================================================

/** Token dummy resmi Turnstile — lolos siteverify test key (aktif s.d. Fase 3). */
const TURNSTILE_DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

const MESH_LOG_LIMIT = 200;
const PAGE_LOG_LIMIT = 200;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function describeError(error: unknown): ErrorDetail {
  if (error instanceof Error) {
    const carrier = error as Error & { code?: unknown; status?: unknown };
    return {
      message: error.message,
      ...(typeof carrier.code === 'string' ? { code: carrier.code } : {}),
      ...(typeof carrier.status === 'number' ? { status: carrier.status } : {}),
    };
  }
  return { message: String(error) };
}

interface MockAudioStream {
  stream: MediaStream;
  contextStateAfterResume: string;
  cleanup: () => void;
}

/**
 * Stream audio sintetis (oscillator → MediaStreamDestination) — pengganti
 * mikrofon yang tidak butuh perangkat/izin, cocok untuk headless.
 */
async function createMockAudioStream(): Promise<MockAudioStream> {
  const audioCtx = new AudioContext();
  try {
    // Autoplay policy bisa membuat resume() menggantung tanpa gestur user
    // (mis. browser automation tanpa flag autoplay) — balapan dengan
    // timeout supaya harness tidak pernah macet; state dilaporkan apa adanya.
    await Promise.race([
      audioCtx.resume(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, 1500);
      }),
    ]);
  } catch {
    // abaikan — perekaman tetap dicoba
  }
  const oscillator = audioCtx.createOscillator();
  oscillator.frequency.value = 440;
  const gain = audioCtx.createGain();
  gain.gain.value = 0.05;
  const destination = audioCtx.createMediaStreamDestination();
  oscillator.connect(gain);
  gain.connect(destination);
  oscillator.start();
  const stream = destination.stream;
  return {
    stream,
    contextStateAfterResume: audioCtx.state,
    cleanup: () => {
      try {
        oscillator.stop();
      } catch {
        // sudah berhenti
      }
      void audioCtx.close();
    },
  };
}

function peerSummary(peer: PeerState): MeshPeerSnapshot {
  return {
    sessionId: peer.sessionId,
    displayName: peer.session.displayName,
    connectionState: peer.connectionState,
    iceConnectionState: peer.iceConnectionState,
    lastPosition: peer.lastPosition,
    lastPositionAt: peer.lastPositionAt,
  };
}

/** Ringkasan pesan signaling untuk log (SDP dipangkas, kandidat utuh). */
function summarizeSignal(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object') {
    return { kind: typeof raw };
  }
  const message = raw as {
    type?: unknown;
    event?: unknown;
    payload?: {
      type?: unknown;
      from?: unknown;
      to?: unknown;
      sdp?: unknown;
      candidate?: unknown;
      sdpMid?: unknown;
    };
  };
  const signal =
    message.payload ??
    (message as {
      type?: unknown;
      from?: unknown;
      to?: unknown;
      sdp?: unknown;
      candidate?: unknown;
      sdpMid?: unknown;
    });
  if (typeof signal.type !== 'string') {
    return { event: message.type ?? message.event ?? 'bukan-signal' };
  }
  const summary: Record<string, unknown> = { type: signal.type };
  if (typeof signal.from === 'string') {
    summary.from = signal.from.slice(0, 16);
  }
  if (typeof signal.to === 'string') {
    summary.to = signal.to.slice(0, 16);
  }
  if (typeof signal.sdp === 'string') {
    const ufrag = /a=ice-ufrag:(\S+)/.exec(signal.sdp)?.[1];
    summary.sdpLen = signal.sdp.length;
    summary.ufrag = ufrag ?? null;
  }
  if (typeof signal.candidate === 'string') {
    summary.cand = signal.candidate.slice(0, 90);
  }
  return summary;
}

// ============================================================
// Harness
// ============================================================

interface HarnessServices {
  profiles: ProfileService;
  snippets: VoiceSnippetService;
  manager: VoiceSnippetManager;
}

class Harness implements HarnessApi {
  #servicesCache: HarnessServices | null = null;
  #lastRecording: VoiceRecordingResult | null = null;
  #mesh: {
    controller: MeshRoomController;
    roomCode: string;
    sessionId: string;
    self: SessionInfo;
  } | null = null;
  #meshLog: MeshLogEntry[] = [];
  #mockMeshStreamCleanup: (() => void) | null = null;
  #pageLog: string[] = [];

  /** Log satu baris ber-stempel waktu ke halaman (pre#harness-log). */
  logLine(line: string): void {
    const stamp = new Date().toISOString().slice(11, 23);
    this.#pageLog.push(`${stamp} ${line}`);
    if (this.#pageLog.length > PAGE_LOG_LIMIT) {
      this.#pageLog.splice(0, this.#pageLog.length - PAGE_LOG_LIMIT);
    }
    const pre = document.getElementById('harness-log');
    if (pre !== null) {
      pre.textContent = this.#pageLog.join('\n');
    }
  }

  /** Layanan profil/snippet (dibuat malas supaya env kosong tidak mematikan halaman). */
  #services(): HarnessServices {
    if (this.#servicesCache === null) {
      const client = getAppSupabase();
      const profiles = new ProfileService({ supabase: asProfileClient(client) });
      const snippets = new VoiceSnippetService({ supabase: client });
      const manager = new VoiceSnippetManager({
        snippets,
        profiles,
        onError: (context, error) =>
          this.logLine(`snippet non-fatal: ${context} — ${describeError(error).message}`),
      });
      this.#servicesCache = { profiles, snippets, manager };
    }
    return this.#servicesCache;
  }

  async #requireUserId(): Promise<string> {
    const { data } = await getAppSupabase().auth.getSession();
    const userId = data.session?.user?.id;
    if (userId === undefined || userId === null || userId === '') {
      throw new Error('belum signin — panggil signIn dulu');
    }
    return userId;
  }

  #pushMeshLog(event: string, detail: Record<string, unknown>): void {
    this.#meshLog.push({ at: new Date().toISOString(), event, detail });
    if (this.#meshLog.length > MESH_LOG_LIMIT) {
      this.#meshLog.splice(0, this.#meshLog.length - MESH_LOG_LIMIT);
    }
    this.logLine(`mesh ${event}: ${JSON.stringify(detail)}`);
  }

  /**
   * Pembungkus diagnostik: mencatat semua sinyal signaling keluar (send)
   * dan masuk (broadcast) ke mesh log — untuk debugging negosiasi WebRTC.
   */
  #instrumentSupabase(): SupabaseRealtimeLike {
    const client = getAppSupabase();
    return {
      // Properti arrow (bukan method) supaya `this` mengikat instance Harness.
      channel: (topic, options) => {
        // Cast tunggal terkontrol: like-type controller lebih sempit daripada
        // RealtimeChannelOptions asli — nilai diteruskan apa adanya.
        const channel = client.channel(topic, options as Parameters<typeof client.channel>[1]);
        const originalSend = channel.send.bind(channel) as (payload: unknown) => Promise<string>;
        channel.send = ((payload: unknown) => {
          this.#pushMeshLog('signal-out', { topic, payload: summarizeSignal(payload) });
          return originalSend(payload);
        }) as typeof channel.send;
        const originalOn = channel.on.bind(channel);
        channel.on = ((event: unknown, ...rest: unknown[]) => {
          if (event === 'broadcast') {
            const originalCallback = rest[1] as ((message: unknown) => void) | undefined;
            if (typeof originalCallback === 'function') {
              rest[1] = (message: unknown) => {
                this.#pushMeshLog('signal-in', { topic, payload: summarizeSignal(message) });
                originalCallback(message);
              };
            }
          }
          const args = [event, ...rest] as Parameters<typeof channel.on>;
          return originalOn(...args);
        }) as typeof channel.on;
        return channel;
      },
      removeChannel: (channel) => client.removeChannel(channel),
    };
  }

  // ----------------------------------------------------------
  // Env & auth
  // ----------------------------------------------------------

  envStatus(): {
    ready: boolean;
    missing: string[];
    hasTurnstileKey: boolean;
    hasSentryDsn: boolean;
    turn: { status: TurnEnvStatus; reasons: string[] };
  } {
    // readTurnEnvFromVite murni dan tidak pernah melempar — aman di luar try.
    const parsed = readTurnEnvFromVite();
    const turn =
      parsed.status === 'invalid'
        ? { status: parsed.status, reasons: parsed.reasons }
        : { status: parsed.status, reasons: [] as string[] };
    try {
      const env = readClientEnv();
      return {
        ready: true,
        missing: [],
        hasTurnstileKey: env.turnstileSiteKey !== undefined,
        hasSentryDsn: env.sentryDsn !== undefined,
        turn,
      };
    } catch (error) {
      const missing =
        error instanceof Error && 'missing' in error ? (error.missing as string[]) : [];
      return { ready: false, missing, hasTurnstileKey: false, hasSentryDsn: false, turn };
    }
  }

  async signUp(email: string, password: string, captchaToken?: string): Promise<AuthProbeResult> {
    try {
      const options = captchaToken === undefined ? {} : { captchaToken };
      const { data, error } = await getAppSupabase().auth.signUp({ email, password, options });
      if (error !== null) {
        this.logLine(`signUp DITOLAK: ${describeError(error).message}`);
        return { ok: false, userId: null, ...describeError(error) };
      }
      this.logLine(`signUp ok: ${data.user?.id ?? '(tanpa user)'}`);
      return { ok: true, userId: data.user?.id ?? null, message: 'signup diterima' };
    } catch (error) {
      return { ok: false, userId: null, ...describeError(error) };
    }
  }

  async signIn(email: string, password: string, captchaToken?: string): Promise<AuthProbeResult> {
    try {
      const token = captchaToken ?? TURNSTILE_DUMMY_TOKEN;
      const { data, error } = await getAppSupabase().auth.signInWithPassword({
        email,
        password,
        options: { captchaToken: token },
      });
      if (error !== null) {
        this.logLine(`signIn DITOLAK: ${describeError(error).message}`);
        return { ok: false, userId: null, ...describeError(error) };
      }
      this.logLine(`signIn ok: ${data.user?.id ?? '(tanpa user)'}`);
      return { ok: true, userId: data.user?.id ?? null, message: 'signin ok' };
    } catch (error) {
      return { ok: false, userId: null, ...describeError(error) };
    }
  }

  async signOut(): Promise<ErrorDetail & { ok: boolean }> {
    try {
      await getAppSupabase().auth.signOut();
      this.logLine('signOut ok');
      return { ok: true, message: 'signout ok' };
    } catch (error) {
      return { ok: false, ...describeError(error) };
    }
  }

  async getSession(): Promise<SessionProbeResult> {
    try {
      const { data } = await getAppSupabase().auth.getSession();
      const user = data.session?.user;
      return {
        signedIn: user !== null && user !== undefined,
        userId: user?.id ?? null,
        email: user?.email ?? null,
      };
    } catch {
      return { signedIn: false, userId: null, email: null };
    }
  }

  // ----------------------------------------------------------
  // Profil + matriks RLS
  // ----------------------------------------------------------

  async probeListProfiles(): Promise<CountProbeResult> {
    try {
      const response = await getAppSupabase().from('profiles').select('id');
      if (response.error !== null) {
        return { ok: false, count: 0, ...describeError(response.error) };
      }
      const count = (response.data ?? []).length;
      this.logLine(`probeListProfiles: ${count} baris terlihat`);
      return { ok: true, count, message: `${count} baris profil terlihat` };
    } catch (error) {
      return { ok: false, count: 0, ...describeError(error) };
    }
  }

  async getProfile(userId?: string): Promise<ProfileResult> {
    try {
      const id = userId ?? (await this.#requireUserId());
      const profile = await this.#services().profiles.getProfile(id);
      this.logLine(`getProfile(${id}): ${profile?.displayName ?? 'null'}`);
      return {
        ok: true,
        profile,
        message: profile === null ? 'baris tidak ada' : 'profil terbaca',
      };
    } catch (error) {
      return { ok: false, profile: null, ...describeError(error) };
    }
  }

  async updateProfile(patch: ProfileUpdate): Promise<ProfileResult> {
    try {
      const userId = await this.#requireUserId();
      const profile = await this.#services().profiles.updateProfile(userId, patch);
      this.logLine(`updateProfile: ${profile.displayName} / ${profile.avatarColor}`);
      return { ok: true, profile, message: 'profil ter-update' };
    } catch (error) {
      return { ok: false, profile: null, ...describeError(error) };
    }
  }

  async probeReadProfile(userId: string): Promise<ReadProbeResult> {
    try {
      const response = await getAppSupabase()
        .from('profiles')
        .select('id, display_name')
        .eq('id', userId)
        .maybeSingle();
      if (response.error !== null) {
        return { ok: false, displayName: null, ...describeError(response.error) };
      }
      const displayName = (response.data as { display_name?: string } | null)?.display_name ?? null;
      this.logLine(`probeReadProfile(${userId}): ${displayName ?? 'tidak terlihat'}`);
      return { ok: true, displayName, message: 'pembacaan lintas user dievaluasi' };
    } catch (error) {
      return { ok: false, displayName: null, ...describeError(error) };
    }
  }

  async probeWriteProfile(userId: string, displayName: string): Promise<WriteProbeResult> {
    try {
      const response = await getAppSupabase()
        .from('profiles')
        .update({ display_name: displayName })
        .eq('id', userId)
        .select('id, display_name');
      if (response.error !== null) {
        return { ok: false, changed: false, ...describeError(response.error) };
      }
      const changed = (response.data ?? []).length > 0;
      this.logLine(
        `probeWriteProfile(${userId}): ${changed ? 'BERUBAH (RLS GAGAL!)' : 'diblokir RLS (0 baris)'}`,
      );
      return {
        ok: true,
        changed,
        message: changed ? 'baris berubah' : 'RLS memblokir (0 baris tersentuh)',
      };
    } catch (error) {
      return { ok: false, changed: false, ...describeError(error) };
    }
  }

  // ----------------------------------------------------------
  // Snippet suara (rekam mock → upload live → signed URL → bersih)
  // ----------------------------------------------------------

  async recordMockSnippet(durationMs: number = 1200): Promise<RecordResult> {
    let mock: MockAudioStream | null = null;
    try {
      mock = await createMockAudioStream();
      const stream = mock.stream;
      const recorder = new VoiceRecorder({ getUserMedia: async () => stream });
      await recorder.start();
      await sleep(durationMs);
      const result = await recorder.stop();
      this.#lastRecording = result;
      this.logLine(
        `recordMockSnippet: ${result.blob.size} byte / ${result.durationMs} ms / ${result.blob.type}`,
      );
      return {
        ok: true,
        bytes: result.blob.size,
        durationMs: result.durationMs,
        mimeType: result.blob.type,
        autoStopped: result.autoStopped,
        contextState: mock.contextStateAfterResume,
        message: 'rekaman mock selesai',
      };
    } catch (error) {
      const described = describeError(error);
      this.logLine(`recordMockSnippet GAGAL: ${described.message}`);
      return {
        ok: false,
        bytes: 0,
        durationMs: 0,
        mimeType: '',
        autoStopped: null,
        contextState: mock?.contextStateAfterResume ?? '',
        ...described,
      };
    } finally {
      mock?.cleanup();
    }
  }

  async uploadLastRecording(): Promise<UploadResult> {
    try {
      if (this.#lastRecording === null) {
        return {
          ok: false,
          path: null,
          fullPath: null,
          bytes: 0,
          previousPath: null,
          previousDeleted: false,
          message: 'belum ada rekaman — panggil recordMockSnippet dulu',
        };
      }
      const userId = await this.#requireUserId();
      const result = await this.#services().manager.replaceSnippet(
        userId,
        this.#lastRecording.blob,
      );
      this.logLine(`uploadLastRecording: ${result.path}`);
      return {
        ok: true,
        path: result.path,
        fullPath: result.fullPath,
        bytes: result.bytes,
        previousPath: result.previousPath,
        previousDeleted: result.previousDeleted,
        message: 'snippet ter-upload & profil menunjuk path baru',
      };
    } catch (error) {
      return {
        ok: false,
        path: null,
        fullPath: null,
        bytes: 0,
        previousPath: null,
        previousDeleted: false,
        ...describeError(error),
      };
    }
  }

  async #activeSnippetPath(path?: string): Promise<string | null> {
    if (path !== undefined) {
      return path;
    }
    const userId = await this.#requireUserId();
    const profile = await this.#services().profiles.getProfile(userId);
    return profile?.voiceSnippetPath ?? null;
  }

  async createPlaybackUrl(path?: string): Promise<PlaybackUrlResult> {
    try {
      const target = await this.#activeSnippetPath(path);
      if (target === null) {
        return {
          ok: false,
          signedUrl: null,
          expiresInS: null,
          message: 'tidak ada path snippet aktif',
        };
      }
      const url = await this.#services().snippets.createPlaybackUrl(target);
      this.logLine(`createPlaybackUrl: ${target}`);
      return {
        ok: true,
        signedUrl: url.signedUrl,
        expiresInS: url.expiresInS,
        message: 'signed url dibuat',
      };
    } catch (error) {
      return { ok: false, signedUrl: null, expiresInS: null, ...describeError(error) };
    }
  }

  async fetchSnippet(path?: string): Promise<FetchSnippetResult> {
    try {
      const target = await this.#activeSnippetPath(path);
      if (target === null) {
        return {
          ok: false,
          status: null,
          contentType: null,
          bytes: 0,
          message: 'tidak ada path snippet aktif',
        };
      }
      const url = await this.#services().snippets.createPlaybackUrl(target);
      const response = await fetch(url.signedUrl);
      const contentType = response.headers.get('content-type');
      const buffer = await response.arrayBuffer();
      this.logLine(
        `fetchSnippet: HTTP ${response.status} / ${buffer.byteLength} byte / ${contentType ?? '?'}`,
      );
      return {
        ok: response.ok,
        status: response.status,
        contentType,
        bytes: buffer.byteLength,
        message: response.ok ? 'objek terunduh via signed url' : `HTTP ${response.status}`,
      };
    } catch (error) {
      return { ok: false, status: null, contentType: null, bytes: 0, ...describeError(error) };
    }
  }

  async listSnippets(): Promise<ListResult> {
    try {
      const userId = await this.#requireUserId();
      const names = await this.#services().snippets.listSnippetNames(userId);
      this.logLine(`listSnippets: ${names.length} objek`);
      return { ok: true, names, message: `${names.length} objek di folder sendiri` };
    } catch (error) {
      return { ok: false, names: [], ...describeError(error) };
    }
  }

  async clearSnippet(): Promise<ClearResult> {
    try {
      const userId = await this.#requireUserId();
      const result = await this.#services().manager.clearSnippet(userId);
      this.logLine(`clearSnippet: ${result.clearedPath ?? 'tidak ada'}`);
      return { ok: true, clearedPath: result.clearedPath, message: 'penunjuk snippet dibersihkan' };
    } catch (error) {
      return { ok: false, clearedPath: null, ...describeError(error) };
    }
  }

  async cleanupSnippets(): Promise<CleanupResult> {
    try {
      const userId = await this.#requireUserId();
      const names = await this.#services().snippets.listSnippetNames(userId);
      let deleted = 0;
      for (const name of names) {
        await this.#services().snippets.deleteSnippet(`${userId}/${name}`);
        deleted += 1;
      }
      const remaining = await this.#services().snippets.listSnippetNames(userId);
      this.logLine(`cleanupSnippets: ${deleted} dihapus, sisa ${remaining.length}`);
      return { ok: true, deleted, remaining, message: `${deleted} objek dihapus` };
    } catch (error) {
      return { ok: false, deleted: 0, remaining: [], ...describeError(error) };
    }
  }

  async probeUploadToFolder(folderUserId: string): Promise<ForeignUploadProbeResult> {
    try {
      const blob =
        this.#lastRecording?.blob ??
        new Blob([new Uint8Array([26, 69, 223, 163, 66, 134, 129, 1])], { type: 'audio/webm' });
      const response = await getAppSupabase()
        .storage.from('voice-snippets')
        .upload(`${folderUserId}/probe-${Date.now()}.webm`, blob, {
          contentType: 'audio/webm',
          upsert: false,
        });
      const blocked = response.error !== null;
      this.logLine(
        `probeUploadToFolder(${folderUserId}): ${blocked ? `DITOLAK — ${response.error?.message}` : 'LOLOS (RLS GAGAL!)'}`,
      );
      return {
        ok: blocked,
        blocked,
        message: blocked
          ? `ditolak: ${response.error?.message ?? 'error'}`
          : 'upload lolos — RLS tidak memblokir!',
      };
    } catch (error) {
      return { ok: false, blocked: true, ...describeError(error) };
    }
  }

  // ----------------------------------------------------------
  // Monitoring (Sentry live)
  // ----------------------------------------------------------

  async initMonitoringLive(): Promise<MonitoringInitResult> {
    try {
      const env = readClientEnv();
      const result = initMonitoring(env.sentryDsn, { environment: 'test-harness' });
      this.logLine(
        `initMonitoringLive: initialized=${result.initialized} skipped=${result.skipped}`,
      );
      return {
        ok: true,
        initialized: result.initialized,
        skipped: result.skipped,
        hasDsn: env.sentryDsn !== undefined,
        message: result.initialized ? 'monitoring ter-init' : `dilewati: ${result.skipped}`,
      };
    } catch (error) {
      return {
        ok: false,
        initialized: false,
        skipped: null,
        hasDsn: false,
        ...describeError(error),
      };
    }
  }

  async captureTestError(label: string): Promise<CaptureResult> {
    try {
      const eventId = captureError(new Error(`test-harness probe: ${label}`), {
        context: 'test-harness',
        data: { label },
      });
      this.logLine(
        `captureTestError('${label}'): eventId=${eventId === '' ? '(kosong)' : eventId}`,
      );
      return {
        ok: eventId !== '',
        eventId,
        message: eventId !== '' ? 'event ditangkap' : 'SDK tidak aktif / eventId kosong',
      };
    } catch (error) {
      return { ok: false, eventId: '', ...describeError(error) };
    }
  }

  async flushMonitoringLive(timeoutMs: number = 5000): Promise<FlushResult> {
    try {
      const sent = await flushMonitoring(timeoutMs);
      this.logLine(`flushMonitoringLive: sent=${sent}`);
      return { ok: true, sent, message: sent ? 'antrean event terkirim' : 'antrean belum habis' };
    } catch (error) {
      return { ok: false, sent: false, ...describeError(error) };
    }
  }

  monitoringStatusLive(): { initialized: boolean; enabled: boolean } {
    return monitoringStatus();
  }

  async verifySentryIngest(): Promise<IngestResult> {
    try {
      const env = readClientEnv();
      if (env.sentryDsn === undefined) {
        return { ok: false, status: null, eventId: '', message: 'VITE_SENTRY_DSN tidak diisi' };
      }
      const dsn = new URL(env.sentryDsn);
      const projectId = dsn.pathname.replaceAll('/', '');
      if (projectId === '') {
        return { ok: false, status: null, eventId: '', message: 'DSN tanpa project id' };
      }
      const eventId = crypto.randomUUID().replaceAll('-', '');
      const response = await fetch(`${dsn.protocol}//${dsn.host}/api/${projectId}/store/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${dsn.username}, sentry_client=test-harness/1.0`,
        },
        body: JSON.stringify({
          event_id: eventId,
          timestamp: new Date().toISOString(),
          platform: 'javascript',
          environment: 'test-harness',
          logger: 'test-harness',
          message: { formatted: `test-harness ingest probe ${new Date().toISOString()}` },
        }),
      });
      this.logLine(`verifySentryIngest: HTTP ${response.status}`);
      return {
        ok: response.ok,
        status: response.status,
        eventId,
        message: response.ok ? 'ingest Sentry menerima event' : `HTTP ${response.status}`,
      };
    } catch (error) {
      return { ok: false, status: null, eventId: '', ...describeError(error) };
    }
  }

  // ----------------------------------------------------------
  // Mesh WebRTC (dipakai e2e dua konteks)
  // ----------------------------------------------------------

  async joinMesh(
    roomCode: string,
    opts: { displayName?: string; avatarColor?: string; attachMockStream?: boolean } = {},
  ): Promise<MeshJoinResult> {
    try {
      if (this.#mesh !== null) {
        return {
          ok: false,
          sessionId: null,
          roomCode: null,
          message: 'sudah join — leaveMesh dulu',
        };
      }
      // Resolusi ICE (Task 8-d): env VITE_TURN_* → iceServers STUN+TURN.
      // Dikerjakan SEBELUM auth supaya status TURN selalu tercatat di log
      // walau join nanti ditolak (belum signin) — masalah konfigurasi tidak
      // ditelan: invalid → log alasan + fallback STUN-only (pola monitoring).
      const { iceServers, turnStatus, reasons } = resolveIceServers();
      if (turnStatus === 'invalid') {
        this.logLine(
          `joinMesh: TURN env INVALID — fallback STUN-only (${(reasons ?? []).join('; ')})`,
        );
      } else if (turnStatus === 'enabled') {
        this.logLine('joinMesh: TURN aktif — STUN default + entri TURN relay');
      }
      const userId = await this.#requireUserId();
      const profile = await this.#services().profiles.getProfile(userId);
      const sessionId = `harness-${crypto.randomUUID().slice(0, 8)}`;
      const self: SessionInfo = {
        sessionId,
        userId,
        displayName: opts.displayName ?? profile?.displayName ?? 'Harness User',
        avatarColor: opts.avatarColor ?? profile?.avatarColor ?? '#22c55e',
      };
      const controller = new MeshRoomController({
        supabase: this.#instrumentSupabase(),
        roomCode,
        self,
        iceServers,
      });
      controller.on('peer-joined', ({ peer }) =>
        this.#pushMeshLog('peer-joined', { peer: peerSummary(peer) }),
      );
      controller.on('peer-left', ({ sessionId: id }) =>
        this.#pushMeshLog('peer-left', { sessionId: id }),
      );
      controller.on('peer-state', ({ peer }) =>
        this.#pushMeshLog('peer-state', { peer: peerSummary(peer) }),
      );
      controller.on('remote-stream', ({ sessionId: id, track }) =>
        this.#pushMeshLog('remote-stream', { sessionId: id, trackKind: track.kind }),
      );
      controller.on('remote-position', ({ sessionId: id, position }) =>
        this.#pushMeshLog('remote-position', { sessionId: id, position }),
      );
      controller.on('room-full', ({ size, max }) => this.#pushMeshLog('room-full', { size, max }));
      controller.on('error', ({ message, cause }) =>
        this.#pushMeshLog('error', {
          message,
          ...(cause === undefined ? {} : { cause: describeError(cause) }),
        }),
      );
      controller.on('invalid-signal', ({ reason }) =>
        this.#pushMeshLog('invalid-signal', { reason }),
      );
      controller.on('invalid-position', ({ sessionId: id, reason }) =>
        this.#pushMeshLog('invalid-position', { sessionId: id, reason }),
      );
      if (opts.attachMockStream === true) {
        const mock = await createMockAudioStream();
        controller.attachLocalStream(mock.stream);
        this.#mockMeshStreamCleanup = mock.cleanup;
      }
      await controller.join();
      this.#mesh = { controller, roomCode, sessionId, self };
      this.logLine(`joinMesh('${roomCode}'): sessionId=${sessionId}`);
      return { ok: true, sessionId, roomCode, message: 'join room ok' };
    } catch (error) {
      this.#mockMeshStreamCleanup?.();
      this.#mockMeshStreamCleanup = null;
      return { ok: false, sessionId: null, roomCode: null, ...describeError(error) };
    }
  }

  async leaveMesh(): Promise<MeshLeaveResult> {
    try {
      if (this.#mesh === null) {
        return { ok: true, message: 'memang tidak sedang join' };
      }
      await this.#mesh.controller.leave();
      this.#mockMeshStreamCleanup?.();
      this.#mockMeshStreamCleanup = null;
      this.#mesh = null;
      this.logLine('leaveMesh ok');
      return { ok: true, message: 'leave room ok' };
    } catch (error) {
      return { ok: false, ...describeError(error) };
    }
  }

  meshState(): MeshStateResult {
    if (this.#mesh === null) {
      return { joined: false, roomCode: null, sessionId: null, self: null, peers: [] };
    }
    const peers = this.#mesh.controller.getPeers().map(peerSummary);
    return {
      joined: true,
      roomCode: this.#mesh.roomCode,
      sessionId: this.#mesh.sessionId,
      self: {
        userId: this.#mesh.self.userId,
        displayName: this.#mesh.self.displayName,
        avatarColor: this.#mesh.self.avatarColor,
      },
      peers,
    };
  }

  setLocalPosition(x: number, y: number): PositionResult {
    try {
      if (this.#mesh === null) {
        return { ok: false, message: 'belum join mesh' };
      }
      this.#mesh.controller.setLocalPosition({ x, y });
      return { ok: true, message: `posisi lokal → (${x}, ${y})` };
    } catch (error) {
      return { ok: false, ...describeError(error) };
    }
  }

  meshLog(): MeshLogEntry[] {
    return this.#meshLog.slice(-50);
  }

  // ----------------------------------------------------------
  // Audio spasial smoke
  // ----------------------------------------------------------

  async audioSmoke(): Promise<AudioSmokeResult> {
    let engine: SpatialAudioEngine | null = null;
    let mock: MockAudioStream | null = null;
    try {
      engine = new SpatialAudioEngine();
      mock = await createMockAudioStream();
      engine.addPeerVoice('smoke-peer', mock.stream);
      engine.setPeerPosition('smoke-peer', { x: 3, y: -4 });
      engine.setMasterVolume(0.5);
      engine.setMuted(true);
      engine.setMuted(false);
      engine.listener.update({ x: 1, y: 2 }, Math.PI / 2);
      const result: AudioSmokeResult = {
        ok: true,
        contextState: engine.contextState,
        peerVoiceIds: engine.peerVoiceIds,
        peerPosition: engine.getPeerPosition('smoke-peer'),
        muted: engine.isMuted,
        disposed: false,
        message: 'audio smoke ok',
      };
      await engine.dispose();
      result.disposed = engine.isDisposed;
      this.logLine(
        `audioSmoke: ctx=${result.contextState}, peers=${result.peerVoiceIds.join(',')}`,
      );
      return result;
    } catch (error) {
      try {
        await engine?.dispose();
      } catch {
        // abaikan — dispose kedua
      }
      return {
        ok: false,
        contextState: engine?.contextState ?? null,
        peerVoiceIds: engine?.peerVoiceIds ?? [],
        peerPosition: engine?.getPeerPosition('smoke-peer') ?? null,
        muted: engine?.isMuted ?? null,
        disposed: engine?.isDisposed ?? false,
        ...describeError(error),
      };
    } finally {
      mock?.cleanup();
    }
  }
}

// ============================================================
// Pasang ke halaman
// ============================================================

window.__harness = new Harness();

function renderStatus(): void {
  const element = document.getElementById('harness-status');
  if (element === null) {
    return;
  }
  try {
    const env = readClientEnv();
    element.textContent =
      'harness siap — env klien lengkap. ' +
      `turnstileSiteKey: ${env.turnstileSiteKey !== undefined ? 'terisi' : 'kosong'}, ` +
      `sentryDsn: ${env.sentryDsn !== undefined ? 'terisi' : 'kosong'}. ` +
      'Gunakan window.__harness.* dari devtools atau Playwright.';
  } catch (error) {
    element.textContent = `harness TIDAK siap — ${error instanceof Error ? error.message : String(error)}`;
  }
}

renderStatus();
