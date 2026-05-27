/**
 * Minimal event emitter used internally by the snippet.
 *
 * All listener callbacks receive `unknown` payload internally; the public
 * window.wiredhowseAuth API exposes typed overloads. Using `unknown` (not
 * `any`) keeps the no-`any` rule intact — callers narrow the payload at the
 * boundary they control.
 */

export type Listener = (payload?: unknown) => void;

export class EventEmitter {
  private readonly listeners = new Map<string, Listener[]>();

  /**
   * Subscribe to an event. Returns an unsubscribe function (the `off` form
   * the spec shows as `const off = auth.on(...); off();`).
   */
  on(event: string, cb: Listener): () => void {
    const list = this.listeners.get(event) ?? [];
    list.push(cb);
    this.listeners.set(event, list);
    return () => this.off(event, cb);
  }

  /** Unsubscribe by reference — symmetrical with `on`. */
  off(event: string, cb: Listener): void {
    const list = this.listeners.get(event);
    if (!list) return;
    const idx = list.indexOf(cb);
    if (idx !== -1) list.splice(idx, 1);
  }

  /**
   * Emit an event to all current subscribers.
   * Iterates over a snapshot so that listeners added/removed during
   * dispatch do not affect the current cycle.
   */
  emit(event: string, payload?: unknown): void {
    const list = this.listeners.get(event);
    if (!list || list.length === 0) return;
    for (const listener of [...list]) {
      try {
        listener(payload);
      } catch {
        // Swallow listener errors — one bad callback must not break others.
      }
    }
  }

  /** Remove all listeners for a given event (used in tests / teardown). */
  removeAll(event: string): void {
    this.listeners.delete(event);
  }
}
