/**
 * Tests for src/ui/index.ts — iframe UI bundle.
 *
 * Strategy
 * --------
 *   We import the module in happy-dom which provides window, document, etc.
 *   The module runs boot() immediately (readyState is set to 'complete').
 *   Each test gets a fresh module instance via vi.resetModules() + dynamic import.
 *
 *   For async API tests we flush the microtask queue explicitly with
 *   await Promise.resolve() chains rather than vi.waitFor, because vi.waitFor
 *   polling can race against stale render callbacks from previous module instances
 *   (each module load adds a window 'message' listener that is never removed,
 *   and they share the same happy-dom document).
 *
 * Compile-time constants (__API_BASE__, __VERSION__) are injected by esbuild
 * during the real build; for tests we stub them as globals.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE = 'https://magic-link.wiredhowse.app';
const VERSION = '1.0.0';
const CUSTOMER_ORIGIN = 'https://customer.com';

// ---------------------------------------------------------------------------
// Microtask flush helper
// ---------------------------------------------------------------------------

/**
 * Flushes the microtask queue N times.
 *
 * Each await Promise.resolve() yields back to the event loop and allows
 * pending microtasks (awaited Promises) to run. Three ticks covers:
 *   tick 1 → fetch() resolves → sendMagicLink resumes
 *   tick 2 → res.json() resolves → sendMagicLink resumes, calls setState
 *   tick 3 → render() and requestAnimationFrame callbacks settle
 */
async function flushMicrotasks(ticks = 3): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function getInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('#wh-email-input');
}

function getSubmitBtn(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('.wh-btn');
}

function getCloseBtn(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('.wh-close');
}

function getAlert(): HTMLElement | null {
  return document.querySelector('[role="alert"]');
}

function getSentIcon(): HTMLElement | null {
  return document.querySelector('.wh-sent-icon');
}

function getHeadline(): string {
  return document.querySelector('.wh-headline')?.textContent ?? '';
}

function getRetryBtn(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('.wh-retry');
}

/**
 * Sets the email input value and dispatches the form submit event.
 * Uses direct `.value` assignment which works in happy-dom.
 */
function submitEmail(email: string): void {
  const input = getInput();
  if (input !== null) {
    input.value = email;
  }
  const form = document.querySelector<HTMLFormElement>('#wh-email-form');
  form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

/** Fire a MessageEvent that appears to come from window.parent. */
function fireParentMessage(data: unknown, origin: string): void {
  const event = new MessageEvent('message', {
    data,
    origin,
    source: window.parent as WindowProxy,
  });
  window.dispatchEvent(event);
}

// ---------------------------------------------------------------------------
// Module loader
// ---------------------------------------------------------------------------

let mockParentPostMessage: ReturnType<typeof vi.fn>;

/**
 * Loads (or reloads) the UI module with a clean document state.
 * Call this at the start of every test that needs the module.
 *
 * Any fetch mock should be set up (via vi.spyOn or direct assignment)
 * BEFORE or INSIDE this function — the module's sendMagicLink() reads
 * the global fetch at call time, not at import time.
 */
async function loadUiModule(): Promise<void> {
  // Reset DOM to a clean slate.
  document.head.innerHTML = '';
  document.body.innerHTML = '';

  // Fresh module instance — module-level state (cardEl, state, params) resets.
  vi.resetModules();

  // Inject esbuild compile-time constants as window properties.
  vi.stubGlobal('__API_BASE__', API_BASE);
  vi.stubGlobal('__VERSION__', VERSION);

  // Simulate DOMContentLoaded already fired so boot() runs synchronously.
  Object.defineProperty(document, 'readyState', {
    value: 'complete',
    configurable: true,
    writable: true,
  });

  // Simulate being inside the iframe: location search params.
  Object.defineProperty(window, 'location', {
    value: {
      href: `${API_BASE}/v1/snippet/ui?site_key=pk_test&origin=${CUSTOMER_ORIGIN}`,
      search: `?site_key=pk_test&origin=${CUSTOMER_ORIGIN}`,
      pathname: '/v1/snippet/ui',
      hash: '',
      origin: API_BASE,
    },
    configurable: true,
    writable: true,
  });

  // Make window.parent !== window (iframe mode) and capture postMessage calls.
  mockParentPostMessage = vi.fn();
  Object.defineProperty(window, 'parent', {
    value: { postMessage: mockParentPostMessage },
    configurable: true,
    writable: true,
  });

  // Import — boot() runs synchronously here because readyState === 'complete'.
  await import('./index');

  // Flush any queued microtasks from boot().
  await flushMicrotasks(2);
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// Boot behaviour
// ---------------------------------------------------------------------------

describe('boot', () => {
  it('injects a <style> element into document.head', async () => {
    await loadUiModule();
    expect(document.head.querySelector('style')).not.toBeNull();
  });

  it('renders the .wh-card element in document.body', async () => {
    await loadUiModule();
    expect(document.querySelector('.wh-card')).not.toBeNull();
  });

  it('sends wh:ready to parent after rendering', async () => {
    await loadUiModule();
    const readyCall = mockParentPostMessage.mock.calls.find(
      (args: unknown[]) => {
        const msg = args[0];
        return (
          typeof msg === 'object' &&
          msg !== null &&
          (msg as Record<string, unknown>)['type'] === 'wh:ready'
        );
      },
    );
    expect(readyCall).toBeDefined();
  });

  it('targets CUSTOMER_ORIGIN as postMessage targetOrigin', async () => {
    await loadUiModule();
    for (const [, target] of mockParentPostMessage.mock.calls as [unknown, string][]) {
      expect(target).toBe(CUSTOMER_ORIGIN);
    }
  });
});

// ---------------------------------------------------------------------------
// Email entry form (initial state)
// ---------------------------------------------------------------------------

describe('email-entry state', () => {
  it('renders an email input', async () => {
    await loadUiModule();
    const input = getInput();
    expect(input).not.toBeNull();
    expect(input!.type).toBe('email');
  });

  it('renders a submit button with "Send magic link" text', async () => {
    await loadUiModule();
    const btn = getSubmitBtn();
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toContain('Send magic link');
  });

  it('renders a close/dismiss button', async () => {
    await loadUiModule();
    expect(getCloseBtn()).not.toBeNull();
  });

  it('input has autocomplete=email for browser autofill', async () => {
    await loadUiModule();
    expect(getInput()!.getAttribute('autocomplete')).toBe('email');
  });
});

// ---------------------------------------------------------------------------
// Close button → wh:dismiss
// ---------------------------------------------------------------------------

describe('close button', () => {
  it('sends wh:dismiss to parent when clicked', async () => {
    await loadUiModule();
    getCloseBtn()!.click();

    const dismissCall = mockParentPostMessage.mock.calls.find(
      (args: unknown[]) => {
        const msg = args[0];
        return (
          typeof msg === 'object' &&
          msg !== null &&
          (msg as Record<string, unknown>)['type'] === 'wh:dismiss'
        );
      },
    );
    expect(dismissCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Client-side form validation
// ---------------------------------------------------------------------------

describe('form validation', () => {
  it('shows an error alert when submitted with an empty email', async () => {
    await loadUiModule();
    submitEmail('');
    expect(getAlert()).not.toBeNull();
    expect(getAlert()!.textContent).toContain('valid email');
  });

  it('shows an error alert when submitted without an @ character', async () => {
    await loadUiModule();
    submitEmail('notanemail');
    expect(getAlert()).not.toBeNull();
  });

  it('does not call fetch for invalid emails', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    await loadUiModule();
    submitEmail('bad');
    await flushMicrotasks();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Successful magic-link request
// ---------------------------------------------------------------------------

describe('sendMagicLink — success', () => {
  it('transitions to the "sent" state on a successful API response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue({ data: { sent: true, expires_in_seconds: 900 } }),
      }),
    );
    await loadUiModule();

    submitEmail('test@example.com');
    // flush: handleSubmit → setState(loading), void sendMagicLink starts
    // flush: fetch() microtask resolves, sendMagicLink continues
    // flush: res.json() microtask resolves, setState(sent) called, render runs
    await flushMicrotasks(5);

    expect(getHeadline()).toBe('Check your inbox');
    expect(getSentIcon()).not.toBeNull();
  });

  it('shows the submitted email address in the sent state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue({ data: { sent: true, expires_in_seconds: 900 } }),
      }),
    );
    await loadUiModule();

    submitEmail('alice@example.com');
    await flushMicrotasks(5);

    expect(document.body.textContent).toContain('alice@example.com');
  });

  it('sends the email and X-Site-Key header to the magic-link API', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({ data: { sent: true, expires_in_seconds: 900 } }),
    });
    vi.stubGlobal('fetch', mockFetch);
    await loadUiModule();

    submitEmail('user@example.com');
    await flushMicrotasks(5);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/snippet/magic-link/request');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Site-Key']).toBe('pk_test');
    const body = JSON.parse(init.body as string) as { email: string };
    expect(body.email).toBe('user@example.com');
  });

  it('uses credentials: omit on the fetch call', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({ data: { sent: true, expires_in_seconds: 900 } }),
    });
    vi.stubGlobal('fetch', mockFetch);
    await loadUiModule();

    submitEmail('x@x.com');
    await flushMicrotasks(5);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe('omit');
  });

  it('includes redirect_to in the body when set via URL param', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({ data: { sent: true, expires_in_seconds: 900 } }),
    });
    vi.stubGlobal('fetch', mockFetch);

    // Reload module with redirect_to in the URL.
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    vi.resetModules();
    vi.stubGlobal('__API_BASE__', API_BASE);
    vi.stubGlobal('__VERSION__', VERSION);
    Object.defineProperty(document, 'readyState', { value: 'complete', configurable: true });
    Object.defineProperty(window, 'location', {
      value: {
        search: `?site_key=pk_test&origin=${CUSTOMER_ORIGIN}&redirect_to=https://example.com/app`,
        pathname: '/v1/snippet/ui',
        hash: '',
        origin: API_BASE,
      },
      configurable: true,
      writable: true,
    });
    mockParentPostMessage = vi.fn();
    Object.defineProperty(window, 'parent', {
      value: { postMessage: mockParentPostMessage },
      configurable: true,
      writable: true,
    });
    await import('./index');
    await flushMicrotasks(2);

    submitEmail('user@example.com');
    await flushMicrotasks(5);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { email: string; redirect_to?: string };
    expect(body.redirect_to).toBe('https://example.com/app');
  });
});

// ---------------------------------------------------------------------------
// API error states
// ---------------------------------------------------------------------------

describe('sendMagicLink — errors', () => {
  it('shows "wait a moment" copy on RATE_LIMITED code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue({
          error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded' },
        }),
      }),
    );
    await loadUiModule();

    submitEmail('test@example.com');
    await flushMicrotasks(5);

    expect(getAlert()).not.toBeNull();
    expect(getAlert()!.textContent).toContain('wait a moment');
  });

  it('shows "unavailable" copy on SITE_DISABLED code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue({
          error: { code: 'SITE_DISABLED', message: 'Site is disabled' },
        }),
      }),
    );
    await loadUiModule();

    submitEmail('test@example.com');
    await flushMicrotasks(5);

    expect(getAlert()).not.toBeNull();
    expect(getAlert()!.textContent).toContain('unavailable');
  });

  it('shows "connection" copy when fetch throws a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await loadUiModule();

    submitEmail('test@example.com');
    await flushMicrotasks(5);

    expect(getAlert()).not.toBeNull();
    expect(getAlert()!.textContent).toContain('connection');
  });

  it('re-renders the email form (not the sent state) after an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue({
          error: { code: 'GENERIC_ERROR', message: 'Something failed' },
        }),
      }),
    );
    await loadUiModule();

    submitEmail('test@example.com');
    await flushMicrotasks(5);

    // Email input still present (error state shows the form).
    expect(getInput()).not.toBeNull();
    // Not showing the "sent" icon.
    expect(getSentIcon()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// "Try again" button in sent state
// ---------------------------------------------------------------------------

describe('sent state', () => {
  it('clicking "Try again" returns to the email-entry form', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue({ data: { sent: true, expires_in_seconds: 900 } }),
      }),
    );
    await loadUiModule();

    submitEmail('test@example.com');
    await flushMicrotasks(5);

    // Should be in sent state now.
    expect(getRetryBtn()).not.toBeNull();

    getRetryBtn()!.click();

    // Back to email-entry.
    expect(getInput()).not.toBeNull();
    expect(getSentIcon()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// wh:options message from parent
// ---------------------------------------------------------------------------

describe('wh:options from parent', () => {
  it('accepts wh:options from window.parent without throwing', async () => {
    await loadUiModule();
    expect(() =>
      fireParentMessage({ type: 'wh:options', message: 'Please sign in' }, CUSTOMER_ORIGIN),
    ).not.toThrow();
  });

  it('updates the headline after receiving wh:options with a custom message', async () => {
    await loadUiModule();

    const msg = 'Members-only content — please sign in';
    fireParentMessage({ type: 'wh:options', message: msg }, CUSTOMER_ORIGIN);
    await flushMicrotasks(2);

    expect(getHeadline()).toContain(msg);
  });

  it('ignores wh:options from a source that is not window.parent', async () => {
    await loadUiModule();
    const originalHeadline = getHeadline();

    // Fire from `window` instead of `window.parent`.
    const event = new MessageEvent('message', {
      data: { type: 'wh:options', message: 'Injected!' },
      origin: CUSTOMER_ORIGIN,
      source: window as unknown as WindowProxy,
    });
    window.dispatchEvent(event);
    await flushMicrotasks(1);

    expect(getHeadline()).toBe(originalHeadline);
  });
});

// ---------------------------------------------------------------------------
// wh:size reporting
// ---------------------------------------------------------------------------

describe('wh:size reporting', () => {
  it('sends wh:size to parent after the initial render (via rAF)', async () => {
    await loadUiModule();

    // Let requestAnimationFrame callbacks fire.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await flushMicrotasks(1);

    const sizeCall = mockParentPostMessage.mock.calls.find(
      (args: unknown[]) => {
        const msg = args[0];
        return (
          typeof msg === 'object' &&
          msg !== null &&
          (msg as Record<string, unknown>)['type'] === 'wh:size'
        );
      },
    );
    expect(sizeCall).toBeDefined();
    const sizeMsg = sizeCall![0] as { type: string; height: number };
    expect(typeof sizeMsg.height).toBe('number');
    expect(sizeMsg.height).toBeGreaterThanOrEqual(0);
  });
});
