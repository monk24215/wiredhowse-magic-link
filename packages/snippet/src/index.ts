/**
 * wiredhowse-magic-link snippet v1
 * https://magic-link.wiredhowse.app/v1/snippet.js
 *
 * Embedded on customer sites via:
 *   <script src="https://magic-link.wiredhowse.app/v1/snippet.js"
 *           data-site-key="pk_..."
 *           data-mode="auto"
 *           async defer></script>
 *
 * The IIFE sets window.wiredhowseAuth and optionally calls
 * window[data-on-loaded]() when ready. Any calls made before the script
 * loads are captured via the async-queue pattern:
 *   window.wiredhowseAuth = window.wiredhowseAuth || { q: [] };
 *   window.wiredhowseAuth.q.push(['on', 'session', cb]);
 */

import { ApiClient, ApiError } from './api';
import { EventEmitter } from './events';
import { clearHandoffFragment, parseHandoffFragment } from './fragment';
import { type IframeOptions, hideAuthIframe, showAuthIframe } from './iframe';
import { clearStoredSession, getStoredSession, setStoredSession } from './storage';
import type { AuthEvent, RequireSessionOptions, Session } from './types';

// ---------------------------------------------------------------------------
// Compile-time constants (injected by esbuild define)
// ---------------------------------------------------------------------------
declare const __API_BASE__: string;
declare const __VERSION__: string;

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const emitter = new EventEmitter();
let api: ApiClient | null = null;
let siteKey = '';
let position: 'center' | 'top' | 'bottom' = 'center';
let apiBase = __API_BASE__;

// ---------------------------------------------------------------------------
// Core session logic
// ---------------------------------------------------------------------------

/**
 * Validates the stored token against the server.
 * On success: updates storage with fresh session data, emits 'session'.
 * On failure / no token: clears storage, returns null.
 */
async function validateStoredSession(): Promise<Session | null> {
  if (!api) return null;

  const stored = getStoredSession(siteKey);
  if (!stored) return null;

  try {
    const result = await api.checkSession(stored.token);
    if (!result.valid) {
      clearStoredSession(siteKey);
      return null;
    }
    // Refresh the cached session object (display_name etc. may have changed).
    setStoredSession(siteKey, { token: stored.token, session: result.session });
    return result.session;
  } catch (err) {
    if (err instanceof ApiError && err.code === 'SITE_DISABLED') {
      emitter.emit('site_disabled');
    }
    // Network errors: leave storage intact so the next load can retry.
    return null;
  }
}

/**
 * Exchanges a handoff token (from the URL fragment after magic-link redemption)
 * for a session token. Stores the session and clears the fragment on success.
 */
async function consumeHandoffFragment(): Promise<Session | null> {
  if (!api) return null;

  const token = parseHandoffFragment(window.location.hash);
  if (!token) return null;

  try {
    const result = await api.exchangeHandoff(token);
    setStoredSession(siteKey, {
      token: result.session_token,
      session: result.session,
    });
    clearHandoffFragment();
    return result.session;
  } catch (err) {
    if (err instanceof ApiError) {
      emitter.emit('error', { code: err.code, message: err.message });
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API implementation
// ---------------------------------------------------------------------------

async function getSession(): Promise<Session | null> {
  // Handoff fragment takes priority: page may have just returned from a
  // magic-link click. Exchange it before falling back to stored token.
  const fromHandoff = await consumeHandoffFragment();
  if (fromHandoff) return fromHandoff;

  return validateStoredSession();
}

async function requireSession(opts?: RequireSessionOptions): Promise<Session> {
  // Loop: the spec says requireSession "loops the user back through email
  // entry indefinitely" rather than rejecting on auth failure.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const session = await getSession();
    if (session) return session;

    // No session — show the iframe and wait for a 'session' event.
    // The session arrives on the NEXT page load (handoff fragment), but the
    // iframe keeps the user in the flow. Unrecoverable errors (site disabled,
    // network down) propagate as rejections.
    await new Promise<void>((resolve, reject) => {
      let sessionOff: (() => void) | null = null;
      let disabledOff: (() => void) | null = null;

      const cleanup = () => {
        sessionOff?.();
        disabledOff?.();
        hideAuthIframe();
      };

      sessionOff = emitter.on('session', () => {
        cleanup();
        resolve();
      });

      disabledOff = emitter.on('site_disabled', () => {
        cleanup();
        reject(new Error('wiredhowse: site is disabled'));
      });

      const iframeOpts: IframeOptions = {
        siteKey,
        position,
        redirectTo: opts?.redirectTo ?? window.location.href,
        apiBase,
        ...(opts?.message !== undefined ? { message: opts.message } : {}),
      };
      showAuthIframe(iframeOpts).catch((err: unknown) => {
        cleanup();
        reject(err instanceof Error ? err : new Error('wiredhowse: iframe error'));
      });
    });

    // After the promise resolves (session event fired), loop back to
    // getSession() to return the validated session object.
  }
}

async function signOut(): Promise<void> {
  if (!api) return;
  const stored = getStoredSession(siteKey);
  if (stored) {
    try {
      await api.signOut(stored.token);
    } catch {
      // Even on API failure, clear local storage and emit signout.
    }
  }
  clearStoredSession(siteKey);
  emitter.emit('signout');
}

// ---------------------------------------------------------------------------
// Pre-load queue type
// ---------------------------------------------------------------------------

// Each queue entry is a tuple: [methodName, ...args]
type QueueEntry = [string, ...unknown[]];

interface PreloadStub {
  q?: QueueEntry[];
}

// ---------------------------------------------------------------------------
// Async-queue replay
// ---------------------------------------------------------------------------

function replayQueue(queue: QueueEntry[]): void {
  for (const entry of queue) {
    const [method, ...args] = entry;
    switch (method) {
      case 'on': {
        const [event, cb] = args;
        if (typeof event === 'string' && typeof cb === 'function') {
          emitter.on(event, cb as (payload?: unknown) => void);
        }
        break;
      }
      case 'off': {
        const [event, cb] = args;
        if (typeof event === 'string' && typeof cb === 'function') {
          emitter.off(event, cb as (payload?: unknown) => void);
        }
        break;
      }
      case 'getSession':
        void getSession();
        break;
      case 'signOut':
        void signOut();
        break;
      // requireSession requires a Promise return; queuing it only makes sense
      // as a fire-and-forget. We call it without capturing the result.
      case 'requireSession': {
        const [opts] = args;
        void requireSession(opts as RequireSessionOptions | undefined);
        break;
      }
      default:
        // Unknown method — ignore silently.
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Script-tag attribute discovery
// ---------------------------------------------------------------------------

function readScriptAttributes(): {
  siteKey: string;
  mode: 'auto' | 'manual';
  position: 'center' | 'top' | 'bottom';
  onLoaded: string | null;
} {
  // document.currentScript is set during the IIFE's synchronous execution,
  // even for async/defer scripts. Capture it at module evaluation time.
  // Fallback: search for the script by src pattern.
  const el =
    (document.currentScript as HTMLScriptElement | null) ??
    (document.querySelector(
      'script[src*="snippet.js"][data-site-key]',
    ) as HTMLScriptElement | null);

  const rawKey = el?.getAttribute('data-site-key') ?? '';
  const rawMode = el?.getAttribute('data-mode') ?? 'auto';
  const rawPos = el?.getAttribute('data-position') ?? 'center';
  const onLoaded = el?.getAttribute('data-on-loaded') ?? null;

  const mode = rawMode === 'manual' ? 'manual' : 'auto';
  const pos: 'center' | 'top' | 'bottom' =
    rawPos === 'top' ? 'top' : rawPos === 'bottom' ? 'bottom' : 'center';

  return { siteKey: rawKey, mode, position: pos, onLoaded };
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

async function init(mode: 'auto' | 'manual', onLoaded: string | null): Promise<void> {
  if (mode === 'auto') {
    // Check for handoff fragment first, then validate stored session.
    const session = await getSession();
    if (session) {
      emitter.emit('session', session);
    } else {
      // Auto mode: render the iframe immediately — the page is gated.
      void requireSession().then((s) => emitter.emit('session', s));
    }
  }

  emitter.emit('ready');

  // Call the data-on-loaded callback if specified.
  if (onLoaded) {
    const cb = (window as unknown as Record<string, unknown>)[onLoaded];
    if (typeof cb === 'function') {
      try {
        (cb as () => void)();
      } catch {
        // Ignore errors in host callbacks.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Bootstrap (IIFE entry point)
// ---------------------------------------------------------------------------

(function bootstrap() {
  // Capture any calls made before this script loaded.
  const prevStub = (window as unknown as Record<string, unknown>)[
    'wiredhowseAuth'
  ] as PreloadStub | undefined;
  const pendingQueue: QueueEntry[] = prevStub?.q ?? [];

  const attrs = readScriptAttributes();
  siteKey = attrs.siteKey;
  position = attrs.position;

  if (!siteKey) {
    console.error(
      `[wiredhowse v${__VERSION__}] Missing data-site-key attribute on the script tag. ` +
        'Authentication is disabled.',
    );
    return;
  }

  api = new ApiClient(siteKey, apiBase);

  // Build the public API object. The `on` method returns an unsubscribe
  // function per spec. We expose typed wrappers here; the EventEmitter
  // handles the actual subscription bookkeeping.
  const wiredhowseAuth = {
    version: __VERSION__,

    getSession(): Promise<Session | null> {
      return getSession();
    },

    requireSession(opts?: RequireSessionOptions): Promise<Session> {
      return requireSession(opts);
    },

    signOut(): Promise<void> {
      return signOut();
    },

    on(event: AuthEvent, cb: (payload?: unknown) => void): () => void {
      return emitter.on(event, cb);
    },

    off(event: AuthEvent, cb: (payload?: unknown) => void): void {
      emitter.off(event, cb);
    },
  };

  // Replace the pre-load stub with the real API object.
  (window as unknown as Record<string, unknown>)['wiredhowseAuth'] = wiredhowseAuth;

  // Replay any queued calls that arrived before the script loaded.
  replayQueue(pendingQueue);

  // Start async initialisation (session check, handoff exchange, etc.).
  void init(attrs.mode, attrs.onLoaded);
})();
