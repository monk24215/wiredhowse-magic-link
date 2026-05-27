/**
 * Tests for src/iframe.ts — parent-side iframe lifecycle manager.
 *
 * happy-dom provides window, document, MessageEvent, and basic DOM APIs.
 * We simulate postMessage by constructing MessageEvent instances and
 * dispatching them on window. The `source` property (read-only in the
 * browser) is overridden via the MessageEvent init object — happy-dom
 * allows this.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hideAuthIframe, showAuthIframe } from './iframe';
import type { IframeOptions } from './iframe';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API_BASE = 'https://magic-link.wiredhowse.app';

const DEFAULT_OPTS: IframeOptions = {
  siteKey: 'pk_test123',
  position: 'center',
  apiBase: API_BASE,
};

/**
 * Fires a synthetic MessageEvent on window.
 * happy-dom lets `source` be provided via the init dict.
 */
function fireMessage(
  data: unknown,
  origin: string,
  source?: EventTarget | null,
): void {
  const event = new MessageEvent('message', {
    data,
    origin,
    source: source as WindowProxy | null,
  });
  window.dispatchEvent(event);
}

/** Returns the wrapper overlay element, or null if absent. */
function getWrapper(): HTMLElement | null {
  return document.getElementById('__wh_auth_wrapper__');
}

/** Returns the iframe element inside the wrapper, or null. */
function getIframe(): HTMLIFrameElement | null {
  return document.getElementById('__wh_auth_iframe__') as HTMLIFrameElement | null;
}

/** Returns the backdrop div (first child of wrapper). */
function getBackdrop(): HTMLElement | null {
  const wrapper = getWrapper();
  return wrapper?.firstElementChild as HTMLElement | null;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Ensure window.innerHeight is something reasonable.
  vi.stubGlobal('innerHeight', 800);
  vi.stubGlobal('innerWidth', 1200);
});

afterEach(() => {
  // Remove any DOM remnants between tests.
  hideAuthIframe();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// showAuthIframe — DOM structure
// ---------------------------------------------------------------------------

describe('showAuthIframe', () => {
  describe('DOM construction', () => {
    it('appends a wrapper div to document.body', async () => {
      void showAuthIframe(DEFAULT_OPTS);
      expect(getWrapper()).not.toBeNull();
    });

    it('wrapper has role=dialog and aria-modal=true', () => {
      void showAuthIframe(DEFAULT_OPTS);
      const w = getWrapper()!;
      expect(w.getAttribute('role')).toBe('dialog');
      expect(w.getAttribute('aria-modal')).toBe('true');
    });

    it('appends an iframe with the correct src', () => {
      void showAuthIframe(DEFAULT_OPTS);
      const iframe = getIframe();
      expect(iframe).not.toBeNull();
      const src = new URL(iframe!.src);
      expect(src.origin).toBe(API_BASE);
      expect(src.pathname).toBe('/v1/snippet/ui');
      expect(src.searchParams.get('site_key')).toBe(DEFAULT_OPTS.siteKey);
    });

    it('encodes origin param from window.location.origin', () => {
      void showAuthIframe(DEFAULT_OPTS);
      const src = new URL(getIframe()!.src);
      // happy-dom default origin is 'http://localhost'
      expect(src.searchParams.get('origin')).toBeTruthy();
    });

    it('includes redirect_to param when provided', () => {
      void showAuthIframe({ ...DEFAULT_OPTS, redirectTo: 'https://example.com/page' });
      const src = new URL(getIframe()!.src);
      expect(src.searchParams.get('redirect_to')).toBe('https://example.com/page');
    });

    it('omits redirect_to param when not provided', () => {
      void showAuthIframe(DEFAULT_OPTS);
      const src = new URL(getIframe()!.src);
      expect(src.searchParams.has('redirect_to')).toBe(false);
    });

    it('iframe has sandbox attribute with required tokens', () => {
      void showAuthIframe(DEFAULT_OPTS);
      const sandbox = getIframe()!.getAttribute('sandbox') ?? '';
      expect(sandbox).toContain('allow-forms');
      expect(sandbox).toContain('allow-scripts');
      expect(sandbox).toContain('allow-same-origin');
    });

    it('applies position:fixed to wrapper', () => {
      void showAuthIframe(DEFAULT_OPTS);
      expect(getWrapper()!.style.position).toBe('fixed');
    });

    it('only creates one overlay even if called twice', () => {
      void showAuthIframe(DEFAULT_OPTS);
      void showAuthIframe(DEFAULT_OPTS); // second call should replace
      expect(document.querySelectorAll('#__wh_auth_wrapper__').length).toBe(1);
    });

    it('includes a backdrop div as first child of wrapper', () => {
      void showAuthIframe(DEFAULT_OPTS);
      const backdrop = getBackdrop();
      expect(backdrop).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // wh:dismiss → resolve
  // -------------------------------------------------------------------------

  describe('wh:dismiss message', () => {
    it('resolves the promise on wh:dismiss from the correct origin', async () => {
      const promise = showAuthIframe(DEFAULT_OPTS);
      const iframeWin = getIframe()?.contentWindow ?? null;

      fireMessage({ type: 'wh:dismiss' }, new URL(API_BASE).origin, iframeWin);

      await expect(promise).resolves.toBeUndefined();
    });

    it('removes the wrapper from DOM after wh:dismiss', async () => {
      const promise = showAuthIframe(DEFAULT_OPTS);
      const iframeWin = getIframe()?.contentWindow ?? null;

      fireMessage({ type: 'wh:dismiss' }, new URL(API_BASE).origin, iframeWin);
      await promise;

      expect(getWrapper()).toBeNull();
    });

    it('ignores wh:dismiss from wrong origin', async () => {
      const promise = showAuthIframe(DEFAULT_OPTS);
      const iframeWin = getIframe()?.contentWindow ?? null;

      // Fire from evil origin — should be ignored.
      fireMessage({ type: 'wh:dismiss' }, 'https://evil.com', iframeWin);

      // Wrapper should still be present.
      expect(getWrapper()).not.toBeNull();

      // Clean up by firing the legitimate dismiss.
      fireMessage({ type: 'wh:dismiss' }, new URL(API_BASE).origin, iframeWin);
      await promise;
    });

    it('ignores wh:dismiss from wrong source window even if origin matches', async () => {
      const promise = showAuthIframe(DEFAULT_OPTS);

      // Fire from a spoofed source (window itself instead of iframe.contentWindow).
      fireMessage(
        { type: 'wh:dismiss' },
        new URL(API_BASE).origin,
        window, // not the iframe's contentWindow
      );

      // Still present — message was rejected.
      expect(getWrapper()).not.toBeNull();

      // Cleanup.
      const iframeWin = getIframe()?.contentWindow ?? null;
      fireMessage({ type: 'wh:dismiss' }, new URL(API_BASE).origin, iframeWin);
      await promise;
    });
  });

  // -------------------------------------------------------------------------
  // wh:ready → send wh:options
  // -------------------------------------------------------------------------

  describe('wh:ready → wh:options', () => {
    it('posts wh:options to the iframe on wh:ready', async () => {
      const opts: IframeOptions = {
        ...DEFAULT_OPTS,
        message: 'Hello from site owner',
        redirectTo: 'https://customer-site.com/dashboard',
      };
      const promise = showAuthIframe(opts);
      const iframe = getIframe()!;
      const iframeWin = iframe.contentWindow;

      // Spy on the iframe's postMessage so we can inspect calls.
      const postSpy = vi.spyOn(iframeWin!, 'postMessage');

      // Simulate iframe sending wh:ready.
      fireMessage({ type: 'wh:ready' }, new URL(API_BASE).origin, iframeWin);

      expect(postSpy).toHaveBeenCalledOnce();
      const [msgArg, targetOrigin] = postSpy.mock.calls[0] as [Record<string, unknown>, string];
      expect(msgArg['type']).toBe('wh:options');
      expect(msgArg['message']).toBe('Hello from site owner');
      expect(msgArg['redirectTo']).toBe('https://customer-site.com/dashboard');
      expect(targetOrigin).toBe(new URL(API_BASE).origin);

      // Cleanup.
      fireMessage({ type: 'wh:dismiss' }, new URL(API_BASE).origin, iframeWin);
      await promise;
    });

    it('does not include message key when message is undefined', async () => {
      const promise = showAuthIframe(DEFAULT_OPTS);
      const iframe = getIframe()!;
      const iframeWin = iframe.contentWindow;
      const postSpy = vi.spyOn(iframeWin!, 'postMessage');

      fireMessage({ type: 'wh:ready' }, new URL(API_BASE).origin, iframeWin);

      const [msgArg] = postSpy.mock.calls[0] as [Record<string, unknown>, string];
      expect('message' in msgArg).toBe(false);

      fireMessage({ type: 'wh:dismiss' }, new URL(API_BASE).origin, iframeWin);
      await promise;
    });

    it('sends wh:options only once even if multiple wh:ready messages arrive', async () => {
      const promise = showAuthIframe(DEFAULT_OPTS);
      const iframeWin = getIframe()?.contentWindow;
      const postSpy = vi.spyOn(iframeWin!, 'postMessage');

      fireMessage({ type: 'wh:ready' }, new URL(API_BASE).origin, iframeWin);
      fireMessage({ type: 'wh:ready' }, new URL(API_BASE).origin, iframeWin);
      fireMessage({ type: 'wh:ready' }, new URL(API_BASE).origin, iframeWin);

      expect(postSpy).toHaveBeenCalledOnce();

      fireMessage({ type: 'wh:dismiss' }, new URL(API_BASE).origin, iframeWin);
      await promise;
    });

    it('ignores wh:ready from wrong origin', async () => {
      const promise = showAuthIframe(DEFAULT_OPTS);
      const iframeWin = getIframe()?.contentWindow;
      const postSpy = vi.spyOn(iframeWin!, 'postMessage');

      fireMessage({ type: 'wh:ready' }, 'https://evil.com', iframeWin);

      expect(postSpy).not.toHaveBeenCalled();

      fireMessage({ type: 'wh:dismiss' }, new URL(API_BASE).origin, iframeWin);
      await promise;
    });
  });

  // -------------------------------------------------------------------------
  // wh:size → resize iframe
  // -------------------------------------------------------------------------

  describe('wh:size message', () => {
    it('sets iframe height from wh:size payload', async () => {
      const promise = showAuthIframe(DEFAULT_OPTS);
      const iframeWin = getIframe()?.contentWindow ?? null;
      const iframe = getIframe()!;

      fireMessage({ type: 'wh:size', height: 350 }, new URL(API_BASE).origin, iframeWin);

      expect(iframe.style.height).toBe('350px');

      fireMessage({ type: 'wh:dismiss' }, new URL(API_BASE).origin, iframeWin);
      await promise;
    });

    it('clamps height to window.innerHeight - 32', async () => {
      vi.stubGlobal('innerHeight', 400);
      const promise = showAuthIframe(DEFAULT_OPTS);
      const iframeWin = getIframe()?.contentWindow ?? null;
      const iframe = getIframe()!;

      fireMessage({ type: 'wh:size', height: 9999 }, new URL(API_BASE).origin, iframeWin);

      // 400 - 32 = 368
      expect(iframe.style.height).toBe('368px');

      fireMessage({ type: 'wh:dismiss' }, new URL(API_BASE).origin, iframeWin);
      await promise;
    });

    it('ignores wh:size with non-numeric height', async () => {
      const promise = showAuthIframe(DEFAULT_OPTS);
      const iframeWin = getIframe()?.contentWindow ?? null;
      const iframe = getIframe()!;
      const initialHeight = iframe.style.height;

      fireMessage({ type: 'wh:size', height: 'big' }, new URL(API_BASE).origin, iframeWin);

      expect(iframe.style.height).toBe(initialHeight);

      fireMessage({ type: 'wh:dismiss' }, new URL(API_BASE).origin, iframeWin);
      await promise;
    });

    it('ignores wh:size with height <= 0', async () => {
      const promise = showAuthIframe(DEFAULT_OPTS);
      const iframeWin = getIframe()?.contentWindow ?? null;
      const iframe = getIframe()!;
      const initialHeight = iframe.style.height;

      fireMessage({ type: 'wh:size', height: 0 }, new URL(API_BASE).origin, iframeWin);

      expect(iframe.style.height).toBe(initialHeight);

      fireMessage({ type: 'wh:dismiss' }, new URL(API_BASE).origin, iframeWin);
      await promise;
    });
  });

  // -------------------------------------------------------------------------
  // Backdrop click → dismiss
  // -------------------------------------------------------------------------

  describe('backdrop click', () => {
    it('resolves the promise when the backdrop is clicked', async () => {
      const promise = showAuthIframe(DEFAULT_OPTS);
      const backdrop = getBackdrop()!;

      backdrop.click();

      await expect(promise).resolves.toBeUndefined();
    });

    it('removes the wrapper after backdrop click', async () => {
      const promise = showAuthIframe(DEFAULT_OPTS);
      getBackdrop()!.click();
      await promise;

      expect(getWrapper()).toBeNull();
    });

    it('does not double-resolve if backdrop is clicked twice', async () => {
      // The `settled` guard should prevent double resolution.
      const promise = showAuthIframe(DEFAULT_OPTS);
      const backdrop = getBackdrop()!;

      backdrop.click();
      backdrop.click(); // second click should be no-op

      await expect(promise).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Position variants
  // -------------------------------------------------------------------------

  describe('position option', () => {
    it.each(['center', 'top', 'bottom'] as const)(
      'produces valid iframe style for position=%s',
      async (pos) => {
        const promise = showAuthIframe({ ...DEFAULT_OPTS, position: pos });
        const iframe = getIframe()!;

        expect(iframe.style.position).toBe('absolute');

        if (pos === 'top') expect(iframe.style.top).toBe('16px');
        if (pos === 'bottom') expect(iframe.style.bottom).toBe('16px');

        // Clean up.
        getBackdrop()!.click();
        await promise;
      },
    );
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('rejects with descriptive error for invalid apiBase', async () => {
      const promise = showAuthIframe({ ...DEFAULT_OPTS, apiBase: 'not-a-url' });
      await expect(promise).rejects.toThrow('invalid apiBase URL');
    });

    it('ignores messages with non-object data', async () => {
      const promise = showAuthIframe(DEFAULT_OPTS);
      const iframeWin = getIframe()?.contentWindow ?? null;

      // Fire a string message — should not throw or crash.
      fireMessage('hello', new URL(API_BASE).origin, iframeWin);
      fireMessage(42, new URL(API_BASE).origin, iframeWin);
      fireMessage(null, new URL(API_BASE).origin, iframeWin);

      expect(getWrapper()).not.toBeNull();

      fireMessage({ type: 'wh:dismiss' }, new URL(API_BASE).origin, iframeWin);
      await promise;
    });
  });
});

// ---------------------------------------------------------------------------
// hideAuthIframe
// ---------------------------------------------------------------------------

describe('hideAuthIframe', () => {
  it('removes the wrapper if present', () => {
    void showAuthIframe(DEFAULT_OPTS);
    expect(getWrapper()).not.toBeNull();

    hideAuthIframe();

    expect(getWrapper()).toBeNull();
  });

  it('does not throw when no overlay is present', () => {
    expect(() => hideAuthIframe()).not.toThrow();
  });

  it('can be called multiple times safely', () => {
    void showAuthIframe(DEFAULT_OPTS);
    hideAuthIframe();
    expect(() => hideAuthIframe()).not.toThrow();
    expect(getWrapper()).toBeNull();
  });
});
