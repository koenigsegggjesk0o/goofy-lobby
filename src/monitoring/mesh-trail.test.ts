import { describe, expect, it } from 'vitest';

import {
  MESH_TRAIL_DETAIL_MAX_KEYS,
  MESH_TRAIL_MESSAGE_MAX_CHARS,
  MESH_TRAIL_VALUE_MAX_CHARS,
  meshTrail,
} from './mesh-trail';

describe('meshTrail', () => {
  it('memetakan event + detail biasa: message "mesh <event>", category mesh, level info', () => {
    const trail = meshTrail('peer-joined', { peer: 'abc' });
    expect(trail.message).toBe('mesh peer-joined');
    expect(trail.category).toBe('mesh');
    expect(trail.level).toBe('info');
    expect(trail.data.event).toBe('peer-joined');
    expect(trail.data.detail).toEqual({ peer: 'abc' });
    expect(trail.data.detailKeysDropped).toBeUndefined();
  });

  it('event "error" → level error (naik, bukan info)', () => {
    expect(meshTrail('error', { message: 'boom' }).level).toBe('error');
  });

  it('event kosong/whitespace → "unknown", tetap tercatat', () => {
    const trail = meshTrail('   ', {});
    expect(trail.message).toBe('mesh unknown');
    expect(trail.data.event).toBe('unknown');
  });

  it('detail kosong → kunci detail dihilangkan (breadcrumb ringkas)', () => {
    const trail = meshTrail('peer-left', {});
    expect(trail.data.detail).toBeUndefined();
    expect(trail.data.detailKeysDropped).toBeUndefined();
  });

  it('nama event dipangkas di message dengan penanda terpotong; data.event tetap nama asli (identifier)', () => {
    const longEvent = 'e'.repeat(MESH_TRAIL_MESSAGE_MAX_CHARS + 40);
    const trail = meshTrail(longEvent, {});
    expect(trail.message.startsWith('mesh ')).toBe(true);
    expect(trail.message).toContain('terpotong');
    expect(trail.message.length).toBeLessThanOrEqual(MESH_TRAIL_MESSAGE_MAX_CHARS + 30);
    // data.event = identifier asli (dipercaya kecil; pangkasan hanya utk display).
    expect(trail.data.event).toBe(longEvent);
  });

  it('nilai string panjang dipangkas dengan penanda panjang asli', () => {
    const long = 'x'.repeat(MESH_TRAIL_VALUE_MAX_CHARS + 100);
    const value = meshTrail('peer-state', { note: long }).data.detail?.note;
    expect(typeof value).toBe('string');
    expect(String(value).length).toBeLessThanOrEqual(MESH_TRAIL_VALUE_MAX_CHARS + 30);
    expect(String(value)).toContain('terpotong');
  });

  it('nilai number/boolean/null diteruskan apa adanya (tanpa serial)', () => {
    const detail = meshTrail('room-full', { size: 8, max: 8, extra: null }).data.detail;
    expect(detail).toEqual({ size: 8, max: 8, extra: null });
  });

  it('nilai objek di-serial ke teks terbatas', () => {
    const value = meshTrail('peer-state', { peer: { sessionId: 's1', state: 'connected' } }).data
      .detail?.peer;
    expect(typeof value).toBe('string');
    expect(String(value)).toContain('s1');
    expect(String(value)).toContain('connected');
  });

  it('objek sirkular TIDAK melempar — fallback teks', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;
    expect(() => meshTrail('error', { cause: circular })).not.toThrow();
    const value = meshTrail('error', { cause: circular }).data.detail?.cause;
    expect(typeof value).toBe('string');
  });

  it('kunci detail berlebih dibuang dan dihitung di detailKeysDropped', () => {
    const detail: Record<string, unknown> = {};
    for (let i = 0; i < MESH_TRAIL_DETAIL_MAX_KEYS + 5; i += 1) {
      detail[`k${i}`] = i;
    }
    const trail = meshTrail('peer-joined', detail);
    const included = Object.keys(trail.data.detail ?? {});
    expect(included.length).toBe(MESH_TRAIL_DETAIL_MAX_KEYS);
    expect(trail.data.detailKeysDropped).toBe(5);
    // Kunci yang disertakan adalah yang pertama (urutan sisipan), bukan acak.
    expect(included[0]).toBe('k0');
    expect(included[included.length - 1]).toBe(`k${MESH_TRAIL_DETAIL_MAX_KEYS - 1}`);
  });
});
