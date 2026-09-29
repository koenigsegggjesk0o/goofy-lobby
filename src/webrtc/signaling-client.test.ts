import { describe, expect, it, vi } from 'vitest';
import { SignalingClient } from './signaling-client';
import { asChannel, FakeRealtimeChannel, flush, makeSession } from './test-utils';
import type { SignalMessage } from './types';

const self = makeSession({ sessionId: 'self-session-0001' });
const remote = makeSession({ sessionId: 'remote-session-02' });

function setup() {
  const channel = new FakeRealtimeChannel('room:X8BBY001', {
    config: { presence: { key: self.sessionId } },
  });
  const onMessage = vi.fn();
  const onInvalid = vi.fn();
  const onSendError = vi.fn();
  const client = new SignalingClient({
    channel: asChannel(channel),
    selfSessionId: self.sessionId,
    onMessage,
    onInvalid,
    onSendError,
  });
  return { channel, client, onMessage, onInvalid, onSendError };
}

const offer: SignalMessage = {
  v: 1,
  type: 'offer',
  from: remote.sessionId,
  to: self.sessionId,
  sdp: 'v=0\r\nfake-offer',
};

describe('SignalingClient', () => {
  it('menyampaikan pesan valid yang ditujukan kepada kita', () => {
    const { channel, client, onMessage } = setup();
    client.bind();

    channel.deliverSignal(offer);

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(offer);
  });

  it('mengabaikan pesan untuk sessionId lain', () => {
    const { channel, client, onMessage } = setup();
    client.bind();

    channel.deliverSignal({ ...offer, to: 'session-lain-9999' });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('mengabaikan echo pesan dari diri sendiri', () => {
    const { channel, client, onMessage } = setup();
    client.bind();

    channel.deliverSignal({ ...offer, from: self.sessionId });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('menerima bye broadcast (to: "*")', () => {
    const { channel, client, onMessage } = setup();
    client.bind();

    channel.deliverSignal({ v: 1, type: 'bye', from: remote.sessionId, to: '*' });

    expect(onMessage).toHaveBeenCalledWith({ v: 1, type: 'bye', from: remote.sessionId, to: '*' });
  });

  it('melaporkan payload yang gagal validasi ke onInvalid', () => {
    const { channel, client, onMessage, onInvalid } = setup();
    client.bind();

    channel.deliverSignal({ type: 'offer', from: remote.sessionId, to: self.sessionId }); // v & sdp hilang

    expect(onMessage).not.toHaveBeenCalled();
    expect(onInvalid).toHaveBeenCalledTimes(1);
    expect(typeof onInvalid.mock.calls[0]?.[0]).toBe('string');
  });

  it('melaporkan payload null ke onInvalid (divalidasi Zod)', () => {
    const { channel, client, onMessage, onInvalid } = setup();
    client.bind();

    channel.deliverSignal(null);

    expect(onMessage).not.toHaveBeenCalled();
    expect(onInvalid).toHaveBeenCalledTimes(1);
    expect(onInvalid.mock.calls[0]?.[0]).toContain('expected object');
  });

  it('setelah unbind() pesan masuk tidak diproses', () => {
    const { channel, client, onMessage } = setup();
    client.bind();
    client.unbind();

    channel.deliverSignal(offer);

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('sebelum bind() pesan tidak diproses dan send() tidak mengirim', () => {
    const { channel, client, onMessage } = setup();

    channel.deliverSignal(offer);
    client.send(offer);

    expect(onMessage).not.toHaveBeenCalled();
    expect(channel.sentSignals).toHaveLength(0);
  });

  it('send() menyiarkan pesan pada event signal', () => {
    const { channel, client } = setup();
    client.bind();

    client.send(offer);

    expect(channel.sentSignals).toEqual([offer]);
  });

  it('melaporkan kegagalan pengiriman ke onSendError', async () => {
    const channel = new FakeRealtimeChannel('room:X8BBY001');
    channel.send = async () => 'error';
    const onSendError = vi.fn();
    const client = new SignalingClient({
      channel: asChannel(channel),
      selfSessionId: self.sessionId,
      onMessage: () => undefined,
      onSendError,
    });
    client.bind();

    client.send(offer);
    await Promise.resolve();

    expect(onSendError).toHaveBeenCalledWith('error');
  });

  // ---- Task 11-c: edges lifecycle & ketangguhan (celah audit 28 Sep) ----

  it('bind() idempoten — bind ganda hanya memasang satu handler', () => {
    const { channel, client, onMessage } = setup();
    client.bind();
    client.bind();

    expect(channel.broadcastHandlers.get('signal') ?? []).toHaveLength(1);

    channel.deliverSignal(offer);
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('re-bind setelah unbind memproses pesan masuk kembali', () => {
    const { channel, client, onMessage } = setup();
    client.bind();
    channel.deliverSignal(offer);
    expect(onMessage).toHaveBeenCalledTimes(1);

    client.unbind();
    channel.deliverSignal(offer);
    expect(onMessage).toHaveBeenCalledTimes(1);

    client.bind();
    channel.deliverSignal(offer);
    expect(onMessage).toHaveBeenCalledTimes(2);
  });

  it('send() setelah unbind tidak mengirim apa pun', () => {
    const { channel, client } = setup();
    client.bind();
    client.unbind();

    client.send(offer);

    expect(channel.sentSignals).toHaveLength(0);
  });

  it('send() yang di-reject channel dilaporkan ke onSendError (bukan unhandled)', async () => {
    const channel = new FakeRealtimeChannel('room:X8BBY001');
    channel.send = async () => {
      throw new Error('jaringan mati');
    };
    const onSendError = vi.fn();
    const client = new SignalingClient({
      channel: asChannel(channel),
      selfSessionId: self.sessionId,
      onMessage: () => undefined,
      onSendError,
    });
    client.bind();

    client.send(offer);
    await flush();

    expect(onSendError).toHaveBeenCalledTimes(1);
    expect(onSendError).toHaveBeenCalledWith('Error: jaringan mati');
  });

  it('send() dengan response ok tidak memanggil onSendError', async () => {
    const { channel, client, onSendError } = setup();
    client.bind();

    client.send(offer);
    await flush();

    expect(channel.sentSignals).toEqual([offer]);
    expect(onSendError).not.toHaveBeenCalled();
  });

  it('envelope broadcast rusak (bukan objek / null) dilaporkan ke onInvalid, bukan crash', () => {
    const { channel, client, onMessage, onInvalid } = setup();
    client.bind();

    channel.deliverRawSignal('envelope-string-rusak');
    channel.deliverRawSignal(null);

    expect(onMessage).not.toHaveBeenCalled();
    expect(onInvalid).toHaveBeenCalledTimes(2);
    expect(onInvalid).toHaveBeenNthCalledWith(1, 'payload broadcast bukan objek');
    expect(onInvalid).toHaveBeenNthCalledWith(2, 'payload broadcast bukan objek');
  });

  it('alasan onInvalid memuat path field yang bermasalah (kontrak diagnostik)', () => {
    const { channel, client, onInvalid } = setup();
    client.bind();

    channel.deliverSignal({ type: 'offer', from: remote.sessionId, to: self.sessionId });

    const reason = onInvalid.mock.calls[0]?.[0] ?? '';
    expect(reason).toContain('v:');
    expect(reason).toContain('sdp:');
    expect(reason).toContain(';');
  });
});
