// wiredhowse-magic-link snippet v1
// Implemented in Chunk 6. This file is the skeleton entry point.

export interface Session {
  sessionToken: string;
  expiresAt: string;
  endUser: {
    id: string;
    email: string;
    displayName: string | null;
  };
}

type SessionCallback = (session: Session | null) => void;

const callbacks: { session: SessionCallback[] } = { session: [] };

export const wiredhowseAuth = {
  getSession(): Promise<Session | null> {
    return Promise.resolve(null);
  },

  requireSession(): Promise<Session> {
    return Promise.reject(new Error('Not implemented — Chunk 6'));
  },

  signOut(): Promise<void> {
    return Promise.resolve();
  },

  on(event: 'session' | 'signout', cb: SessionCallback): void {
    if (event === 'session') {
      callbacks.session.push(cb);
    }
  },
};

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).wiredhowseAuth = wiredhowseAuth;
}
