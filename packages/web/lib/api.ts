/**
 * Thin API client for the web package.
 *
 * All requests go through Next.js rewrites: /api/v1/* → API service /v1/*.
 * Credentials are included so the browser sends the wh_owner_session cookie.
 *
 * CSRF protection: the server sets a non-HttpOnly wh_csrf cookie on login.
 * For every state-changing request (POST, PATCH, DELETE) we read that cookie
 * via document.cookie and echo it back in the X-CSRF-Token header.
 * See: packages/api/src/middleware/csrf.ts
 */

const API_BASE = '/api/v1';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Read the wh_csrf double-submit cookie value (only available in the browser). */
function getCsrfToken(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const entry = document.cookie
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith('wh_csrf='));
  return entry ? decodeURIComponent(entry.slice('wh_csrf='.length)) : undefined;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const isMutation = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';

  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (isMutation) {
    const csrf = getCsrfToken();
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }

  const init: RequestInit = {
    method,
    credentials: 'include', // send the wh_owner_session cookie
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };

  const res = await fetch(`${API_BASE}${path}`, init);

  const json = (await res.json()) as
    | { data: T }
    | { error: { code: string; message: string; details?: Record<string, unknown> } };

  if (!res.ok) {
    const err = 'error' in json ? json.error : { code: 'UNKNOWN', message: 'Request failed' };
    throw new ApiError(res.status, err.code, err.message);
  }

  if ('data' in json) return json.data;
  throw new ApiError(res.status, 'UNKNOWN', 'Unexpected response format');
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string, body?: unknown) => request<T>('DELETE', path, body),
};
