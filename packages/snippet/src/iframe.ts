/**
 * Iframe lifecycle manager — parent-side (snippet on customer site).
 *
 * Inserts a fixed-position overlay containing:
 *   - A semi-transparent backdrop  (click → dismiss)
 *   - The auth-UI iframe            (postMessage protocol)
 *
 * postMessage protocol (spec § "Iframe rendering"):
 *   wh:ready   iframe → parent   iframe has rendered; parent sends wh:options
 *   wh:size    iframe → parent   { height: number } — resize iframe element
 *   wh:dismiss iframe → parent   user clicked close/dismiss
 *   wh:options parent → iframe   { message?, redirectTo? } — display options
 *
 * Security:
 *   - All incoming messages are verified: event.origin === iframeOrigin AND
 *     event.source === iframe.contentWindow.
 *   - wh:options is sent with targetOrigin = iframeOrigin (not '*').
 */

export interface IframeOptions {
  siteKey: string;
  position: 'center' | 'top' | 'bottom';
  message?: string;
  redirectTo?: string;
  apiBase: string;
}

// IDs used for DOM lookup across show/hide calls.
const WRAPPER_ID = '__wh_auth_wrapper__';
const IFRAME_ID = '__wh_auth_iframe__';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function positionStyles(pos: 'center' | 'top' | 'bottom'): string {
  // Base styles shared by all positions.
  const base = [
    'position:absolute',
    'left:50%',
    // Clamp width: 420px on desktop, 100vw - 32px on mobile.
    'width:min(420px,calc(100vw - 32px))',
    'border:none',
    'display:block',
    'border-radius:12px',
    'box-shadow:0 8px 32px rgba(0,0,0,0.32)',
    'overflow:hidden',
    // Initial height before the iframe sends wh:size; overridden by wh:size.
    'height:400px',
    'background:transparent',
  ].join(';');

  switch (pos) {
    case 'top':
      return `${base};top:16px;transform:translateX(-50%)`;
    case 'bottom':
      return `${base};bottom:16px;transform:translateX(-50%)`;
    default: // center
      return `${base};top:50%;transform:translate(-50%,-50%)`;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Shows the auth-UI iframe overlay.
 *
 * Returns a Promise that resolves when:
 *   - The user dismisses the dialog (wh:dismiss message or backdrop click).
 *
 * Note: Session establishment happens on the NEXT page load via the
 * handoff-fragment exchange — NOT inside this promise. This promise only
 * tracks the overlay lifecycle.
 *
 * Rejects only on programming errors (e.g. invalid apiBase URL).
 */
export function showAuthIframe(options: IframeOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    // Remove any lingering overlay from a previous call.
    hideAuthIframe();

    let iframeOrigin: string;
    try {
      iframeOrigin = new URL(options.apiBase).origin;
    } catch {
      reject(new Error(`wiredhowse: invalid apiBase URL: ${options.apiBase}`));
      return;
    }

    // Build the iframe src URL.
    const uiUrl = new URL(`${options.apiBase}/v1/snippet/ui`);
    uiUrl.searchParams.set('site_key', options.siteKey);
    // Pass the customer site's origin so the iframe knows where to target
    // its postMessage replies. window.location.origin is always the actual
    // customer origin — not spoofable by the iframe.
    uiUrl.searchParams.set('origin', window.location.origin);
    if (options.redirectTo !== undefined) {
      uiUrl.searchParams.set('redirect_to', options.redirectTo);
    }

    // -----------------------------------------------------------------------
    // DOM construction
    // -----------------------------------------------------------------------

    // Outer wrapper: fixed fullscreen, highest possible z-index.
    const wrapper = document.createElement('div');
    wrapper.id = WRAPPER_ID;
    wrapper.setAttribute('role', 'dialog');
    wrapper.setAttribute('aria-modal', 'true');
    wrapper.setAttribute('aria-label', 'Sign in');
    wrapper.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483647',
      'overflow:hidden',
    ].join(';');

    // Backdrop: fills the wrapper behind the iframe card.
    // Clicking it dismisses the dialog.
    const backdrop = document.createElement('div');
    backdrop.style.cssText = [
      'position:absolute',
      'inset:0',
      'background:rgba(0,0,0,0.55)',
      'cursor:pointer',
    ].join(';');
    backdrop.setAttribute('aria-hidden', 'true');

    // The iframe: positioned inside wrapper, above backdrop (DOM order).
    const iframe = document.createElement('iframe');
    iframe.id = IFRAME_ID;
    iframe.src = uiUrl.toString();
    // allow-same-origin: restores the iframe's natural origin so that fetch
    // calls from within the iframe work without CORS quirks (the iframe and
    // parent are cross-origin to each other regardless of this flag).
    iframe.setAttribute('sandbox', 'allow-forms allow-scripts allow-same-origin');
    iframe.setAttribute('allowtransparency', 'true');
    iframe.setAttribute('title', 'Sign in');
    iframe.style.cssText = positionStyles(options.position);

    wrapper.appendChild(backdrop);
    wrapper.appendChild(iframe);
    document.body.appendChild(wrapper);

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------

    let settled = false;
    let optionsSent = false;

    // -----------------------------------------------------------------------
    // Settlement helpers
    // -----------------------------------------------------------------------

    function cleanup(): void {
      window.removeEventListener('message', handleMessage);
      const el = document.getElementById(WRAPPER_ID);
      if (el) el.remove();
    }

    function settle(resolution: 'resolve' | 'reject', err?: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      if (resolution === 'reject' && err !== undefined) {
        reject(err);
      } else {
        resolve();
      }
    }

    // -----------------------------------------------------------------------
    // postMessage handler
    // -----------------------------------------------------------------------

    function handleMessage(event: MessageEvent): void {
      // Strict double-check: both the origin string AND the source window
      // reference must match. This defeats any attempt by a third-party frame
      // on the same page to spoof messages.
      if (event.origin !== iframeOrigin) return;
      if (event.source !== iframe.contentWindow) return;
      if (typeof event.data !== 'object' || event.data === null) return;

      const msg = event.data as Record<string, unknown>;
      const type = msg['type'];

      switch (type) {
        case 'wh:ready': {
          // Iframe is rendered — send display options exactly once.
          if (!optionsSent) {
            optionsSent = true;
            const optMsg: Record<string, unknown> = { type: 'wh:options' };
            if (options.message !== undefined) optMsg['message'] = options.message;
            if (options.redirectTo !== undefined) optMsg['redirectTo'] = options.redirectTo;
            // Use iframeOrigin as targetOrigin — never '*' for options payloads.
            iframe.contentWindow?.postMessage(optMsg, iframeOrigin);
          }
          break;
        }

        case 'wh:size': {
          const h = msg['height'];
          if (typeof h === 'number' && h > 0) {
            // Cap at viewport height minus 32px padding.
            const maxH = Math.max(200, window.innerHeight - 32);
            iframe.style.height = `${Math.min(Math.ceil(h), maxH)}px`;
          }
          break;
        }

        case 'wh:dismiss': {
          settle('resolve');
          break;
        }
      }
    }

    window.addEventListener('message', handleMessage);

    // Backdrop click = user dismissed the overlay.
    backdrop.addEventListener('click', () => settle('resolve'));
  });
}

/**
 * Removes the auth overlay from the DOM.
 * Safe to call when no overlay is present.
 */
export function hideAuthIframe(): void {
  const el = document.getElementById(WRAPPER_ID);
  if (el) el.remove();
}
