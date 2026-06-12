/**
 * Iframe UI bundle — wh:magic-link sign-in card.
 *
 * Loaded as dist/snippet-ui.js inside the <iframe> at /v1/snippet/ui.
 * The iframe HTML shell (served by the API in Chunk 6c) just loads this script.
 *
 * States
 * ------
 *   email-entry  Initial form; user types email.
 *   loading      Waiting for POST /v1/snippet/magic-link/request.
 *   sent         "Check your inbox" confirmation.
 *   error        Inline error; form still usable.
 *
 * postMessage protocol (spec § "Iframe rendering"):
 *   wh:ready   → parent   Sent on DOMContentLoaded.
 *   wh:size    → parent   { height } on every render cycle.
 *   wh:dismiss → parent   User clicked close / unrecoverable error.
 *   wh:options ← parent   { message?, redirectTo? } — optional overrides.
 *
 * Security
 * --------
 *   Incoming wh:options: verified via event.source === window.parent.
 *   Outgoing messages: targeted at parentOrigin (from URL param) or '*'.
 *   All user data inserted into DOM uses textContent, not innerHTML.
 *   (The one innerHTML call is for the static card skeleton — no user data.)
 */

// Compile-time constants are declared in src/globals.d.ts (shared by all
// snippet bundles). Do not re-declare them here — that causes TS2451.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ErrorKind = 'rate_limited' | 'site_disabled' | 'network_error' | 'generic';

type UiState =
  | { phase: 'email-entry' }
  | { phase: 'loading'; email: string }
  | { phase: 'sent'; email: string }
  | { phase: 'error'; kind: ErrorKind; apiMessage: string };

// ---------------------------------------------------------------------------
// URL params
// ---------------------------------------------------------------------------

interface UiParams {
  siteKey: string;
  /** The customer site's origin — used as postMessage targetOrigin. */
  parentOrigin: string;
  redirectTo: string | null;
  /** Optional custom headline/intro text from wh:options. */
  message: string | null;
}

function readParams(): UiParams {
  const p = new URLSearchParams(window.location.search);
  return {
    siteKey: p.get('site_key') ?? '',
    parentOrigin: p.get('origin') ?? '',
    redirectTo: p.get('redirect_to'),
    message: null, // overridden by wh:options
  };
}

// ---------------------------------------------------------------------------
// Global mutable state
// ---------------------------------------------------------------------------

const params = readParams();
let state: UiState = { phase: 'email-entry' };

// ---------------------------------------------------------------------------
// postMessage helpers
// ---------------------------------------------------------------------------

function sendToParent(msg: Record<string, unknown>): void {
  if (window.parent === window) return; // not in an iframe — safety guard
  const target = params.parentOrigin || '*';
  try {
    window.parent.postMessage(msg, target);
  } catch {
    // Cross-origin access may be restricted (e.g. about:blank parent).
  }
}

function reportSize(): void {
  // Use scrollHeight so the parent can size the iframe to fit content.
  const h = Math.max(
    document.documentElement.scrollHeight,
    document.body.scrollHeight,
  );
  sendToParent({ type: 'wh:size', height: h });
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const CARD_STYLES = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{height:100%;overflow:hidden}
body{
  width:100%;
  height:auto;
  overflow:hidden;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  font-size:15px;
  color:#f2f3f5;
  background:transparent;
}
.wh-card{
  position:relative;
  padding:28px 24px 24px;
  display:flex;
  flex-direction:column;
  gap:16px;
  background:rgba(14,15,18,0.75);
  border:1px solid rgba(42,46,55,0.7);
  border-radius:12px;
  backdrop-filter:blur(16px);
  -webkit-backdrop-filter:blur(16px);
}
.wh-brand{
  font-size:12px;
  font-weight:700;
  letter-spacing:.18em;
  text-transform:uppercase;
  color:#e46432;
  text-align:center;
}
.wh-headline{
  font-size:20px;
  font-weight:700;
  line-height:1.35;
  color:#f2f3f5;
}
.wh-subtext{
  font-size:14px;
  color:#aeb4bf;
  line-height:1.55;
}
.wh-form{display:flex;flex-direction:column;gap:10px}
.wh-label{
  display:block;
  font-size:13px;
  font-weight:500;
  color:#aeb4bf;
  margin-bottom:4px;
}
.wh-input{
  width:100%;
  padding:10px 12px;
  border:1.5px solid #2a2e37;
  border-radius:8px;
  font-size:15px;
  color:#f2f3f5;
  outline:none;
  transition:border-color .15s,box-shadow .15s;
  background:rgba(22,24,29,0.7);
}
.wh-input::placeholder{color:#5a6070}
.wh-input:focus{border-color:#e46432;box-shadow:0 0 0 3px rgba(228,100,50,.18)}
.wh-input:disabled{opacity:.5;cursor:not-allowed}
.wh-btn{
  width:100%;
  padding:11px 16px;
  background:#e46432;
  color:#fff;
  border:none;
  border-radius:8px;
  font-size:15px;
  font-weight:600;
  cursor:pointer;
  transition:background .15s,opacity .15s;
}
.wh-btn:hover:not(:disabled){background:#c8551e}
.wh-btn:disabled{opacity:.6;cursor:not-allowed}
.wh-close{
  position:absolute;
  top:10px;
  right:10px;
  width:28px;
  height:28px;
  border:none;
  background:transparent;
  cursor:pointer;
  border-radius:50%;
  display:flex;
  align-items:center;
  justify-content:center;
  color:#aeb4bf;
  font-size:20px;
  line-height:1;
  transition:background .15s,color .15s;
  padding:0;
}
.wh-close:hover{background:rgba(42,46,55,0.8);color:#f2f3f5}
.wh-alert{
  padding:10px 12px;
  border-radius:8px;
  font-size:13px;
  line-height:1.5;
}
.wh-alert-error{background:rgba(248,113,113,.1);color:#f87171;border:1px solid rgba(248,113,113,.3)}
.wh-sent-icon{font-size:36px;text-align:center}
.wh-retry{
  font-size:13px;
  color:#e46432;
  background:none;
  border:none;
  padding:0;
  cursor:pointer;
  text-decoration:underline;
}
.wh-retry:hover{color:#ffb494}
.wh-footer{
  font-size:11px;
  color:#5a6070;
  text-align:center;
  padding-top:4px;
}
`;

// ---------------------------------------------------------------------------
// DOM helpers (text-content based to avoid XSS)
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function txt(content: string): Text {
  return document.createTextNode(content);
}

function setAttrs(
  element: Element,
  attrs: Record<string, string>,
): void {
  for (const [k, v] of Object.entries(attrs)) {
    element.setAttribute(k, v);
  }
}

// ---------------------------------------------------------------------------
// Error-kind mapping
// ---------------------------------------------------------------------------

function friendlyError(kind: ErrorKind, apiMessage: string): string {
  switch (kind) {
    case 'site_disabled':
      return 'This site’s authentication service is currently unavailable. Please contact the site owner.';
    case 'rate_limited':
      return 'Too many requests. Please wait a moment before trying again.';
    case 'network_error':
      return 'Could not reach the server. Please check your connection and try again.';
    default:
      return apiMessage || 'Something went wrong. Please try again.';
  }
}

function errorKindFromCode(code: string): ErrorKind {
  if (code === 'SITE_DISABLED') return 'site_disabled';
  if (code === 'RATE_LIMITED' || code === 'RATE_LIMIT_EXCEEDED') return 'rate_limited';
  if (code === 'NETWORK_ERROR') return 'network_error';
  return 'generic';
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

let cardEl: HTMLElement | null = null;

/**
 * Replaces card contents for the given state.
 * Uses DOM APIs only — no innerHTML for user-controlled data.
 */
function render(s: UiState): void {
  if (!cardEl) return;

  // Clear existing card contents.
  while (cardEl.firstChild) cardEl.removeChild(cardEl.firstChild);

  // Close button — always present.
  const closeBtn = el('button', 'wh-close');
  closeBtn.setAttribute('type', 'button');
  closeBtn.setAttribute('aria-label', 'Close');
  // Unicode × character — no external icon needed.
  closeBtn.appendChild(txt('×'));
  closeBtn.addEventListener('click', dismiss);
  cardEl.appendChild(closeBtn);

  // Brand label.
  const brand = el('div', 'wh-brand');
  brand.appendChild(txt('wiredHowse'));
  cardEl.appendChild(brand);

  switch (s.phase) {
    case 'email-entry': {
      renderEmailForm(cardEl, false, null);
      break;
    }
    case 'loading': {
      renderEmailForm(cardEl, true, null);
      break;
    }
    case 'sent': {
      renderSentState(cardEl, s.email);
      break;
    }
    case 'error': {
      renderEmailForm(cardEl, false, friendlyError(s.kind, s.apiMessage));
      break;
    }
  }

  // Report new height to parent after the browser has painted.
  requestAnimationFrame(reportSize);
}

function renderEmailForm(
  container: HTMLElement,
  loading: boolean,
  errorText: string | null,
): void {
  // Headline
  const headline = el('div', 'wh-headline');
  const customMsg = params.message?.trim();
  headline.appendChild(txt(customMsg || 'Enter your email to continue'));
  container.appendChild(headline);

  // Inline error alert
  if (errorText) {
    const alert = el('div', 'wh-alert wh-alert-error');
    alert.setAttribute('role', 'alert');
    alert.appendChild(txt(errorText));
    container.appendChild(alert);
  }

  // Form
  const form = el('form', 'wh-form');
  form.setAttribute('novalidate', '');
  form.setAttribute('id', 'wh-email-form');

  const labelEl = el('label', 'wh-label');
  labelEl.setAttribute('for', 'wh-email-input');
  labelEl.appendChild(txt('Email address'));

  const input = el('input', 'wh-input');
  setAttrs(input, {
    type: 'email',
    id: 'wh-email-input',
    name: 'email',
    autocomplete: 'email',
    placeholder: 'you@example.com',
    required: '',
    'aria-required': 'true',
  });
  if (loading) {
    input.disabled = true;
    input.setAttribute('aria-disabled', 'true');
  }

  const fieldDiv = el('div');
  fieldDiv.appendChild(labelEl);
  fieldDiv.appendChild(input);

  const submitBtn = el('button', 'wh-btn');
  submitBtn.setAttribute('type', 'submit');
  if (loading) {
    submitBtn.disabled = true;
    submitBtn.setAttribute('aria-disabled', 'true');
    submitBtn.appendChild(txt('Sending…'));
  } else {
    submitBtn.appendChild(txt('Send magic link'));
  }

  form.appendChild(fieldDiv);
  form.appendChild(submitBtn);
  form.addEventListener('submit', handleSubmit);
  container.appendChild(form);

  // Footer
  const footer = el('div', 'wh-footer');
  footer.appendChild(txt(`Magic link auth by wiredHowse v${__VERSION__}`));
  container.appendChild(footer);

  // Focus the email input (unless we're in the loading state).
  if (!loading) {
    requestAnimationFrame(() => input.focus());
  }
}

function renderSentState(container: HTMLElement, email: string): void {
  const icon = el('div', 'wh-sent-icon');
  icon.setAttribute('aria-hidden', 'true');
  icon.appendChild(txt('✉️'));
  container.appendChild(icon);

  const headline = el('div', 'wh-headline');
  headline.appendChild(txt('Check your inbox'));
  container.appendChild(headline);

  const subtext = el('div', 'wh-subtext');
  subtext.appendChild(txt('We sent a magic link to '));
  const strong = el('strong');
  strong.appendChild(txt(email));
  subtext.appendChild(strong);
  subtext.appendChild(
    txt('. Click the link in the email to sign in — it expires in 15 minutes.'),
  );
  container.appendChild(subtext);

  const retryRow = el('div', 'wh-subtext');
  retryRow.appendChild(txt("Didn’t receive it? "));
  const retryBtn = el('button', 'wh-retry');
  retryBtn.setAttribute('type', 'button');
  retryBtn.appendChild(txt('Try again'));
  retryBtn.addEventListener('click', () => {
    setState({ phase: 'email-entry' });
  });
  retryRow.appendChild(retryBtn);
  container.appendChild(retryRow);

  const footer = el('div', 'wh-footer');
  footer.appendChild(txt(`Magic link auth by wiredHowse v${__VERSION__}`));
  container.appendChild(footer);
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

function setState(next: UiState): void {
  state = next;
  render(state);
}

function dismiss(): void {
  sendToParent({ type: 'wh:dismiss' });
}

// ---------------------------------------------------------------------------
// Form submit handler
// ---------------------------------------------------------------------------

function handleSubmit(event: Event): void {
  event.preventDefault();

  const form = event.currentTarget as HTMLFormElement;
  const input = form.querySelector<HTMLInputElement>('#wh-email-input');
  const email = input?.value.trim() ?? '';

  // Basic client-side validation — real validation happens server-side.
  if (!email || !email.includes('@')) {
    input?.focus();
    // Show a generic error to prompt them to fix the value.
    setState({
      phase: 'error',
      kind: 'generic',
      apiMessage: 'Please enter a valid email address.',
    });
    return;
  }

  // Transition to loading state (preserves email value visually via spinner).
  setState({ phase: 'loading', email });

  void sendMagicLink(email);
}

async function sendMagicLink(email: string): Promise<void> {
  type Body = { email: string; redirect_to?: string };
  const body: Body = { email };
  if (params.redirectTo) body.redirect_to = params.redirectTo;

  let code = 'GENERIC';
  let message = '';

  try {
    const res = await fetch(`${__API_BASE__}/v1/snippet/magic-link/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Site-Key': params.siteKey,
      },
      body: JSON.stringify(body),
      credentials: 'omit',
    });

    const json = (await res.json()) as unknown;
    const env = json as Record<string, unknown>;

    if ('error' in env) {
      const err = env['error'] as { code: string; message: string };
      code = err.code;
      message = err.message;
    } else {
      // Success — the server returns { data: { sent: true, expires_in_seconds: N } }.
      // Even rate-limited-per-email returns sent:true (email enumeration prevention).
      setState({ phase: 'sent', email });
      return;
    }
  } catch {
    code = 'NETWORK_ERROR';
    message = 'Network request failed';
  }

  const kind = errorKindFromCode(code);
  setState({ phase: 'error', kind, apiMessage: message });
}

// ---------------------------------------------------------------------------
// postMessage listener (parent → iframe)
// ---------------------------------------------------------------------------

function handleParentMessage(event: MessageEvent): void {
  // Security: only accept messages from our actual parent frame.
  // (window.parent === window in a non-iframe context, guarded at the top.)
  if (event.source !== window.parent) return;

  // Additionally verify origin if we know it — defense in depth.
  if (params.parentOrigin && event.origin !== params.parentOrigin) return;

  if (typeof event.data !== 'object' || event.data === null) return;
  const msg = event.data as Record<string, unknown>;

  if (msg['type'] === 'wh:options') {
    // Update display options from the parent snippet.
    const m = msg['message'];
    if (typeof m === 'string') params.message = m;
    // redirectTo from parent overrides URL param if provided.
    const r = msg['redirectTo'];
    if (typeof r === 'string') params.redirectTo = r;
    // Re-render current state with new options (only affects email-entry UI).
    if (state.phase === 'email-entry' || state.phase === 'error') {
      render(state);
    }
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function boot(): void {
  // Inject styles.
  const style = document.createElement('style');
  style.textContent = CARD_STYLES;
  document.head.appendChild(style);

  // Build the card shell.
  cardEl = el('div', 'wh-card');
  document.body.appendChild(cardEl);

  // Set up postMessage listener before signalling ready,
  // so we don't miss wh:options sent immediately after wh:ready.
  if (window.parent !== window) {
    window.addEventListener('message', handleParentMessage);
  }

  // Render initial state.
  render(state);

  // Signal parent: we're ready to receive wh:options.
  sendToParent({ type: 'wh:ready' });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  // DOMContentLoaded has already fired (e.g. script at bottom of body).
  boot();
}

// Required so TypeScript treats this as a module (not a global script),
// enabling `import()` in tests and type isolation. No runtime effect.
export {};
