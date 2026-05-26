// Request / response shapes shared between api, web, and snippet.
// Pure TypeScript — no runtime deps. Validated at the boundary with zod-schemas.ts.

export interface MagicLinkRequestBody {
  email: string;
  siteKey: string;
}

export interface MagicLinkRequestResponse {
  sent: boolean;
}

export interface HandoffExchangeBody {
  handoffToken: string;
  siteKey: string;
}

export interface SessionResponse {
  sessionToken: string;
  expiresAt: string;
  endUser: {
    id: string;
    email: string;
    displayName: string | null;
  };
}

export interface SessionCheckResponse {
  valid: boolean;
  session: SessionResponse | null;
}

export interface SignOutBody {
  sessionToken: string;
  siteKey: string;
}

export interface SignOutResponse {
  signedOut: boolean;
}

export interface HealthResponse {
  status: 'ok';
  version: string;
}

export interface ReadinessResponse {
  status: 'ok' | 'degraded';
  checks: {
    postgres: 'ok' | 'error';
    redis: 'ok' | 'error';
  };
}
