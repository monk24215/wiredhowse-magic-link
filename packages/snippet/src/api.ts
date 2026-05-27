/**
 * API client for the snippet → magic-link.wiredhowse.app channel.
 *
 * Every request carries:
 *   - X-Site-Key: <siteKey>         — server resolves the Site and enforces CORS
 *   - Content-Type: application/json
 *   - credentials: 'omit'           — no cookies on cross-origin calls (third-party
 *                                     cookies are dead; Bearer auth is used instead)
 *
 * Sign-out also adds:
 *   - Authorization: Bearer <token>
 *
 * All responses are `{ data: T }` on success or `{ error: { code, message } }` on
 * failure. Unexpected HTTP status codes or JSON parse failures throw ApiError.
 */

import type { Session } from './types';

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ApiEnvelopeSuccess<T> {
  data: T;
}

interface ApiEnvelopeError {
  error: { code: string; message: string };
}

type ApiEnvelope<T> = ApiEnvelopeSuccess<T> | ApiEnvelopeError;

function isApiError<T>(env: ApiEnvelope<T>): env is ApiEnvelopeError {
  return 'error' in env;
}

export class ApiClient {
  constructor(
    private readonly siteKey: string,
    private readonly baseUrl: string,
  ) {}

  private async post<TBody, TResponse>(
    path: string,
    body: TBody,
    token?: string,
  ): Promise<TResponse> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Site-Key': this.siteKey,
    };
    if (token !== undefined) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        credentials: 'omit',
      });
    } catch {
      throw new ApiError('NETWORK_ERROR', 'Network request failed');
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new ApiError('PARSE_ERROR', `Unexpected response from server (HTTP ${res.status})`);
    }

    const env = json as ApiEnvelope<TResponse>;
    if (isApiError(env)) {
      throw new ApiError(env.error.code, env.error.message);
    }
    return env.data;
  }

  // -------------------------------------------------------------------------
  // Typed endpoint methods
  // -------------------------------------------------------------------------

  /** POST /v1/snippet/session/check */
  checkSession(
    token: string,
  ): Promise<{ valid: true; session: Session } | { valid: false }> {
    return this.post<{ token: string }, { valid: true; session: Session } | { valid: false }>(
      '/v1/snippet/session/check',
      { token },
    );
  }

  /** POST /v1/snippet/magic-link/request */
  requestMagicLink(
    email: string,
    redirectTo?: string,
  ): Promise<{ sent: boolean; expires_in_seconds: number }> {
    type Body = { email: string; redirect_to?: string };
    const body: Body = { email };
    if (redirectTo !== undefined) body.redirect_to = redirectTo;
    return this.post<Body, { sent: boolean; expires_in_seconds: number }>(
      '/v1/snippet/magic-link/request',
      body,
    );
  }

  /** POST /v1/snippet/handoff/exchange */
  exchangeHandoff(
    handoffToken: string,
  ): Promise<{ session_token: string; session: Session }> {
    return this.post<{ handoff_token: string }, { session_token: string; session: Session }>(
      '/v1/snippet/handoff/exchange',
      { handoff_token: handoffToken },
    );
  }

  /**
   * POST /v1/snippet/sign-out
   * Requires Authorization: Bearer <token> header.
   */
  signOut(token: string): Promise<{ signed_out: boolean }> {
    return this.post<Record<string, never>, { signed_out: boolean }>(
      '/v1/snippet/sign-out',
      {},
      token,
    );
  }
}
