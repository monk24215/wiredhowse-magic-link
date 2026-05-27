/**
 * Server-side API client. Passes the wh_owner_session cookie from the current
 * request context. For use in Server Components and Route Handlers only.
 */
import { cookies } from 'next/headers';

const API_INTERNAL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export class ServerApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ServerApiError';
  }
}

async function serverRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get('wh_owner_session')?.value;

  const headers: Record<string, string> = {};
  if (sessionCookie) headers.Cookie = `wh_owner_session=${sessionCookie}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const fetchInit: RequestInit = {
    method,
    headers,
    cache: 'no-store',
  };
  if (body !== undefined) fetchInit.body = JSON.stringify(body);

  const res = await fetch(`${API_INTERNAL}/v1${path}`, fetchInit);

  const json = (await res.json()) as { data: T } | { error: { code: string; message: string } };

  if (!res.ok) {
    const err = 'error' in json ? json.error : { code: 'UNKNOWN', message: 'Request failed' };
    throw new ServerApiError(res.status, err.code, err.message);
  }

  if ('data' in json) return json.data;
  throw new ServerApiError(res.status, 'UNKNOWN', 'Unexpected response');
}

export const serverApi = {
  get: <T>(path: string) => serverRequest<T>('GET', path),
  post: <T>(path: string, body: unknown) => serverRequest<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => serverRequest<T>('PATCH', path, body),
  delete: <T>(path: string, body?: unknown) => serverRequest<T>('DELETE', path, body),
};
