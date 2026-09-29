/**
 * Parser pasangan kandidat TERPILIH dari laporan RTCPeerConnection.getStats()
 * — murni, tanpa import, tanpa efek samping (aman dipakai Node maupun
 * browser).
 *
 * Menjawab pertanyaan verifikasi Fase 2 yang LEBIH KUAT daripada sekadar
 * "kandidat relay terkumpul": pasangan mana yang SUNGGUH dipakai koneksi
 * aktif? Kandidat relay yang terkumpul tidak menjamin relaying terjadi —
 * pasangan terpilih (selected candidate pair) adalah bukti aktual.
 *
 * Bentuk entri mengikuti struktur RTCStats (Chrome/Chromium dan Firefox):
 * - `local-candidate` / `remote-candidate` — punya `id` + `candidateType`
 *   (host | srflx | prflx | relay);
 * - `candidate-pair` — punya `localCandidateId` / `remoteCandidateId`,
 *   `state`, `nominated`, dan (Chrome modern) `selected`.
 *
 * Prioritas pemilihan pasangan:
 * 1. `selected === true` (penanda eksplisit Chrome — paling kuat);
 * 2. `state === 'succeeded'` DAN `nominated === true` (jalur standar
 *    Firefox/w3c — pasangan yang dinominasikan dan berhasil);
 * 3. `state === 'succeeded'` pertama (fallback terakhir — diagnosa saja).
 *
 * Tidak ada pasangan yang memenuhi → null (pemanggil melaporkan apa adanya).
 */

/** Bentuk ringkas entri RTCStats yang dibaca parser (structural typing). */
export interface StatsEntryLike {
  id?: string;
  type: string;
  [key: string]: unknown;
}

/** Tipe kandidat ICE standar; 'unknown' = nilai tak dikenal/tidak hadir. */
export type IceCandidateType = 'host' | 'srflx' | 'prflx' | 'relay' | 'unknown';

/** Hasil pembacaan pasangan terpilih. */
export interface SelectedPairInfo {
  localType: IceCandidateType;
  remoteType: IceCandidateType;
  /**
   * Protokol transport kandidat lokal (`protocol` pada stats local-candidate:
   * 'udp' | 'tcp' di Chrome/Firefox). Untuk kandidat relay, ini protokol
   * alamat relay TERHADAP peer — BUKAN protokol kaki klien→TURN (lihat
   * `localRelayProtocol`). null bila browser tidak menyediakan field-nya.
   */
  localProtocol: string | null;
  /** Protokol transport kandidat remote; null bila tidak hadir. */
  remoteProtocol: string | null;
  /**
   * `relayProtocol` kandidat lokal — protokol kaki KLIEN→TURN SERVER
   * ('udp' | 'tcp' | 'tls'; diekspos Chrome pada kandidat relay). Inilah
   * bukti bahwa alokasi relay dibuat lewat TCP/TLS — jalur yang tetap hidup
   * saat firewall memblokir UDP (P0-2 DoD). null bila bukan relay ATAU
   * browser tidak menyediakan field-nya (Firefox lama).
   */
  localRelayProtocol: string | null;
  /** `relayProtocol` kandidat remote — kaki PEER LAWAN→TURN server-nya. */
  remoteRelayProtocol: string | null;
  state: string | null;
  nominated: boolean | null;
  /** `selected` eksplisit (Chrome); null bila browser tidak menyediakan. */
  selected: boolean | null;
  localCandidateId: string | null;
  remoteCandidateId: string | null;
}

function candidateTypeOf(entry: StatsEntryLike): IceCandidateType {
  const value = entry.candidateType;
  if (value === 'host' || value === 'srflx' || value === 'prflx' || value === 'relay') {
    return value;
  }
  return 'unknown';
}

/** Baca protokol transport kandidat; null bila tidak hadir/bukan string. */
function protocolOf(entry: StatsEntryLike | undefined): string | null {
  if (entry === undefined) return null;
  const value = entry.protocol;
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Baca relayProtocol kandidat (kaki klien→TURN server); null bila tidak hadir. */
function relayProtocolOf(entry: StatsEntryLike | undefined): string | null {
  if (entry === undefined) return null;
  const value = entry.relayProtocol;
  return typeof value === 'string' && value !== '' ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/**
 * Normalisasi satu entri: iterator RTCStatsReport (maplike) menghasilkan
 * pasangan [key, value] — value-lah objek stats-nya. Bentuk objek langsung
 * diteruskan apa adanya. Pair yang bukan [string, objek] diperlakukan
 * sebagai entri kosong (type tak dikenal → diabaikan pemanggil).
 */
function normalizeEntry(entry: StatsEntryLike): StatsEntryLike {
  if (!Array.isArray(entry) || entry.length !== 2) {
    return entry;
  }
  const [, value] = entry;
  if (value === null || typeof value !== 'object') {
    return { type: 'unknown-shape' };
  }
  return value as StatsEntryLike;
}

/**
 * Pilih pasangan kandidat terpilih dari daftar entri stats. Mengembalikan null
 * bila tidak ada pasangan yang bisa dipilih.
 *
 * Bentuk input yang diterima (keduanya dinormalisasi lebih dulu):
 * - array of RTCStats-like object (hasil forEach/koleksi manual — bentuk
 *   yang dipakai PeerConnectionManager.readSelectedPair);
 * - array of pair [key, value] (bentuk iterator maplike RTCStatsReport asli —
 *   `[...report]` di browser). Pertahanan ini menutup kelas bug terbukti
 *   (28 Sep 2026): pemanggil lama men-spread report langsung sehingga semua
 *   `entry.type` undefined dan parser selalu diam-null.
 */
export function pickSelectedPair(entries: readonly StatsEntryLike[]): SelectedPairInfo | null {
  const normalized = entries.map(normalizeEntry);
  const candidates = new Map<string, StatsEntryLike>();
  for (const entry of normalized) {
    if (entry.type === 'local-candidate' || entry.type === 'remote-candidate') {
      const id = asString(entry.id);
      if (id !== null) candidates.set(id, entry);
    }
  }

  const pairs = normalized.filter((entry) => entry.type === 'candidate-pair');
  if (pairs.length === 0) return null;

  const explicit = pairs.find((pair) => pair.selected === true);
  const nominatedSucceeded = pairs.find(
    (pair) => pair.state === 'succeeded' && pair.nominated === true,
  );
  const anySucceeded = pairs.find((pair) => pair.state === 'succeeded');
  const pair = explicit ?? nominatedSucceeded ?? anySucceeded;
  if (pair === undefined) return null;

  const localCandidateId = asString(pair.localCandidateId);
  const remoteCandidateId = asString(pair.remoteCandidateId);
  const local = localCandidateId !== null ? candidates.get(localCandidateId) : undefined;
  const remote = remoteCandidateId !== null ? candidates.get(remoteCandidateId) : undefined;

  return {
    localType: local !== undefined ? candidateTypeOf(local) : 'unknown',
    remoteType: remote !== undefined ? candidateTypeOf(remote) : 'unknown',
    localProtocol: protocolOf(local),
    remoteProtocol: protocolOf(remote),
    localRelayProtocol: relayProtocolOf(local),
    remoteRelayProtocol: relayProtocolOf(remote),
    state: asString(pair.state),
    nominated: asBoolean(pair.nominated),
    selected: asBoolean(pair.selected),
    localCandidateId,
    remoteCandidateId,
  };
}

/**
 * true bila pasangan terpilih menunjukkan lokal MELALUI relay — bukti TURN
 * aktif pada jalur koneksi nyata. null (belum ada pasangan) tidak dihitung
 * sebagai bukti apa pun.
 */
export function isSelectedPairRelay(pair: SelectedPairInfo): boolean {
  return pair.localType === 'relay';
}

/**
 * true bila pasangan terpilih adalah relay YANG KAKINYA KE TURN SERVER
 * bukan UDP (`relayProtocol` 'tcp' atau 'tls') — bukti bahwa koneksi tetap
 * hidup melalui jalur yang selamat dari firewall blokir-UDP (P0-2 DoD:
 * "session succeeds via relay setelah UDP diblokir").
 *
 * Kandidat relay dengan relayProtocol 'udp' → false (relay jalan, tapi lewat
 * UDP — tidak membuktikan ketahanan terhadap blokir UDP). relayProtocol
 * null (browser tanpa field tersebut) → false secara jujur: TIDAK ada bukti
 * protokol kaki TURN, jangan diklaim.
 */
export function isSelectedPairRelayOverTcpOrTls(pair: SelectedPairInfo): boolean {
  return (
    pair.localType === 'relay' &&
    (pair.localRelayProtocol === 'tcp' || pair.localRelayProtocol === 'tls')
  );
}
