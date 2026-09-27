import { describe, expect, it, vi } from 'vitest';
import { Emitter } from './typed-emitter';

interface TestEvents {
  ping: { value: number };
  pong: string;
}

/** emit bersifat protected — test memakai subclass kecil. */
class TestEmitter extends Emitter<TestEvents> {
  triggerPing(value: number): void {
    this.emit('ping', { value });
  }

  triggerPong(message: string): void {
    this.emit('pong', message);
  }
}

describe('Emitter', () => {
  it('mengirim payload ke listener yang terdaftar', () => {
    const emitter = new TestEmitter();
    const handler = vi.fn();
    emitter.on('ping', handler);

    emitter.triggerPing(42);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ value: 42 });
  });

  it('tidak mengirim ke event lain', () => {
    const emitter = new TestEmitter();
    const handler = vi.fn();
    emitter.on('pong', handler);

    emitter.triggerPing(1);

    expect(handler).not.toHaveBeenCalled();
  });

  it('fungsi unsubscribe menghentikan listener', () => {
    const emitter = new TestEmitter();
    const handler = vi.fn();
    const unsubscribe = emitter.on('ping', handler);

    unsubscribe();
    emitter.triggerPing(1);

    expect(handler).not.toHaveBeenCalled();
  });

  it('off() menghapus listener', () => {
    const emitter = new TestEmitter();
    const handler = vi.fn();
    emitter.on('ping', handler);

    emitter.off('ping', handler);
    emitter.triggerPing(1);

    expect(handler).not.toHaveBeenCalled();
  });

  it('listener yang melempar error tidak mengganggu listener lain', () => {
    const emitter = new TestEmitter();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const good = vi.fn();
    emitter.on('ping', () => {
      throw new Error('boom');
    });
    emitter.on('ping', good);

    emitter.triggerPing(7);

    expect(good).toHaveBeenCalledWith({ value: 7 });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('clear() menghapus semua listener', () => {
    const emitter = new TestEmitter();
    const a = vi.fn();
    const b = vi.fn();
    emitter.on('ping', a);
    emitter.on('pong', b);

    emitter.clear();
    emitter.triggerPing(1);
    emitter.triggerPong('x');

    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it('banyak listener untuk event yang sama semuanya terpanggil', () => {
    const emitter = new TestEmitter();
    const first = vi.fn();
    const second = vi.fn();
    emitter.on('ping', first);
    emitter.on('ping', second);

    emitter.triggerPing(3);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
