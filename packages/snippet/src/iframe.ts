/**
 * Iframe lifecycle manager — stub for Chunk 6a.
 *
 * Full implementation lives in Chunk 6b (src/iframe.ts → src/ui/index.ts).
 * This stub defines the interface that index.ts depends on so that the main
 * snippet logic is complete and testable in 6a.
 *
 * The real implementation will:
 *  1. Insert a fixed-position <iframe> pointing to /v1/snippet/ui?site_key=...
 *  2. Communicate with the iframe contents via postMessage (strict origin checks).
 *  3. Handle wh:ready, wh:size, wh:dismiss messages from the iframe.
 *  4. Pass wh:options (message, redirectTo) to the iframe on mount.
 */

export interface IframeOptions {
  siteKey: string;
  position: 'center' | 'top' | 'bottom';
  message?: string;
  redirectTo?: string;
  apiBase: string;
}

/**
 * Shows the auth-UI iframe.
 * Returns a promise that resolves when the user dismisses the iframe (wh:dismiss),
 * or rejects on unrecoverable errors (e.g. iframe failed to load).
 *
 * NOTE: Session establishment itself happens via the handoff-fragment flow on
 * the subsequent page load — NOT inside this promise. The promise is only used
 * to know when the user has closed/dismissed the overlay.
 */
export function showAuthIframe(_options: IframeOptions): Promise<void> {
  // Chunk 6b implements this.
  return Promise.reject(
    new Error(
      'wiredhowse: auth iframe not yet implemented — coming in Chunk 6b. ' +
        'Use data-mode="manual" and call requireSession() after 6b ships.',
    ),
  );
}

/** Removes the auth iframe from the DOM if present. */
export function hideAuthIframe(): void {
  // Chunk 6b implements this.
  const el = document.getElementById('__wh_auth_iframe__');
  if (el) el.remove();
}
