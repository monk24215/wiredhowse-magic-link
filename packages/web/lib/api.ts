/**
 * Thin API client for the web package.
 *
 * All requests go through Next.js rewrites: /api/v1/* → API service /v1/*.
 * Credentials are included so the browser sends the wh_owner_session cookie.
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

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: 'include', // send the wh_owner_session cookie
  };

  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }

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
  post: <T>(path: string, body: unknown) => request<T>('POST', path, body),
  get: <T>(path: string) => request<T>('GET', path),
};
