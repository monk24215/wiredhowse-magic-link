/**
 * API client for the /me page.
 *
 * Unlike `lib/api.ts` (which sends the wh_owner_session cookie for the Site
 * Owner dashboard), this client sends the End User session token as a Bearer
 * header. The token comes from sessionStorage (written on mount from the URL
 * hash or a prior visit).
 *
 * All requests go through the Next.js rewrite: /api/v1/* → API /v1/*.
 */

export class MeApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MeApiError';
  }
}

async function meRequest<T>(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`/api/v1${path}`, init);

  const json = (await res.json()) as
    | { data: T }
    | { error: { code: string; message: string } };

  if (!res.ok) {
    const err = 'error' in json ? json.error : { code: 'UNKNOWN', message: 'Request failed' };
    throw new MeApiError(res.status, err.code, err.message);
  }

  if ('data' in json) return json.data;
  throw new MeApiError(res.status, 'UNKNOWN', 'Unexpected response format');
}

export const meApi = {
  get: <T>(path: string, token: string) => meRequest<T>('GET', path, token),
  patch: <T>(path: string, token: string, body: unknown) =>
    meRequest<T>('PATCH', path, token, body),
  post: <T>(path: string, token: string, body?: unknown) =>
    meRequest<T>('POST', path, token, body),
};
