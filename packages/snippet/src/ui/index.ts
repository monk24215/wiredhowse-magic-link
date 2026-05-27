/**
 * Iframe UI bundle entry point — stub for Chunk 6a.
 *
 * This file is the entry point for the SEPARATE esbuild bundle that produces
 * dist/snippet-ui.js. It is loaded inside the <iframe> at /v1/snippet/ui.
 *
 * Full implementation in Chunk 6b covers:
 *  - Email entry form
 *  - "Check your email" state
 *  - Error states (rate limited, site disabled, network error)
 *  - postMessage protocol (wh:ready, wh:size, wh:dismiss, wh:options)
 *  - Strict origin checks on both sides of the postMessage channel
 *  - Minimal styling, no framework, accessible
 */

// Signal the parent that the iframe is ready (even as a stub).
if (typeof parent !== 'undefined' && parent !== window) {
  try {
    parent.postMessage({ type: 'wh:ready' }, '*');
  } catch {
    // Cross-origin restrictions — the real implementation handles this properly.
  }
}
