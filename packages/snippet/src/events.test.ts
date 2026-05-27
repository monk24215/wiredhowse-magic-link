import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from './events';

describe('EventEmitter', () => {
  describe('on / emit', () => {
    it('calls a listener when the event is emitted', () => {
      const emitter = new EventEmitter();
      const cb = vi.fn();
      emitter.on('session', cb);
      emitter.emit('session', { id: 'sess_1' });
      expect(cb).toHaveBeenCalledOnce();
      expect(cb).toHaveBeenCalledWith({ id: 'sess_1' });
    });

    it('calls multiple listeners in registration order', () => {
      const emitter = new EventEmitter();
      const order: number[] = [];
      emitter.on('session', () => order.push(1));
      emitter.on('session', () => order.push(2));
      emitter.emit('session');
      expect(order).toEqual([1, 2]);
    });

    it('does not call listeners for different events', () => {
      const emitter = new EventEmitter();
      const cb = vi.fn();
      emitter.on('session', cb);
      emitter.emit('signout');
      expect(cb).not.toHaveBeenCalled();
    });

    it('handles emission with no listeners gracefully', () => {
      const emitter = new EventEmitter();
      expect(() => emitter.emit('ready')).not.toThrow();
    });

    it('returns an unsubscribe function', () => {
      const emitter = new EventEmitter();
      const cb = vi.fn();
      const off = emitter.on('session', cb);
      off();
      emitter.emit('session');
      expect(cb).not.toHaveBeenCalled();
    });

    it('only unsubscribes the specific listener, not others', () => {
      const emitter = new EventEmitter();
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      const off1 = emitter.on('session', cb1);
      emitter.on('session', cb2);
      off1();
      emitter.emit('session');
      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).toHaveBeenCalledOnce();
    });
  });

  describe('off', () => {
    it('removes a listener by reference', () => {
      const emitter = new EventEmitter();
      const cb = vi.fn();
      emitter.on('session', cb);
      emitter.off('session', cb);
      emitter.emit('session');
      expect(cb).not.toHaveBeenCalled();
    });

    it('does not throw when removing a non-existent listener', () => {
      const emitter = new EventEmitter();
      const cb = vi.fn();
      expect(() => emitter.off('session', cb)).not.toThrow();
    });

    it('does not remove the wrong listener when callbacks are different refs', () => {
      const emitter = new EventEmitter();
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      emitter.on('session', cb1);
      emitter.off('session', cb2); // remove cb2, which was never added
      emitter.emit('session');
      expect(cb1).toHaveBeenCalledOnce();
    });
  });

  describe('emit', () => {
    it('swallows errors thrown by listeners so other listeners still run', () => {
      const emitter = new EventEmitter();
      const throwing = vi.fn().mockImplementation(() => {
        throw new Error('oops');
      });
      const safe = vi.fn();
      emitter.on('session', throwing);
      emitter.on('session', safe);
      expect(() => emitter.emit('session')).not.toThrow();
      expect(safe).toHaveBeenCalledOnce();
    });

    it('iterates a snapshot so listeners added during emit do not run in that cycle', () => {
      const emitter = new EventEmitter();
      const calls: string[] = [];
      emitter.on('session', () => {
        calls.push('first');
        emitter.on('session', () => calls.push('added-during-emit'));
      });
      emitter.emit('session');
      expect(calls).toEqual(['first']);
      // Second emit picks up the newly added listener.
      emitter.emit('session');
      expect(calls).toContain('added-during-emit');
    });
  });

  describe('removeAll', () => {
    it('removes all listeners for the given event', () => {
      const emitter = new EventEmitter();
      const cb = vi.fn();
      emitter.on('session', cb);
      emitter.on('session', cb);
      emitter.removeAll('session');
      emitter.emit('session');
      expect(cb).not.toHaveBeenCalled();
    });

    it('does not affect listeners for other events', () => {
      const emitter = new EventEmitter();
      const session = vi.fn();
      const ready = vi.fn();
      emitter.on('session', session);
      emitter.on('ready', ready);
      emitter.removeAll('session');
      emitter.emit('ready');
      expect(ready).toHaveBeenCalledOnce();
    });
  });
});
