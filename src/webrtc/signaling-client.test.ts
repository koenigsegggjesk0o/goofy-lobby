import { describe, expect, it, vi } from 'vitest';
import { SignalingClient } from './signaling-client';
import { asChannel, FakeRealtimeChannel, makeSession } from './test-utils';
import type { SignalMessage } from './types';

const self = makeSession({ sessionId: 'self-session-0001' });
const remote = makeSession({ sessionId: 'remote-session-02' });

function setup() {
  const channel = new FakeRealtimeChannel('room:lobby01', {
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
    const channel = new FakeRealtimeChannel('room:lobby01');
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
});
