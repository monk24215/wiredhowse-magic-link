import { db, oauthState, siteOwnerSessions, siteOwners } from '@wiredhowse/db';
import { ErrorCode } from '@wiredhowse/shared';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { config } from '../../config';
import { sendError } from '../../errors';
import { generateToken, hashToken } from '../../lib/crypto';
import { buildCsrfCookie, buildOwnerSessionCookie } from '../../lib/cookies';
import { randomBytes } from 'node:crypto';
import { hashBytes } from '../../lib/hashing';
import { addDays, addMinutes, nowUtc } from '../../lib/time';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const OAUTH_STATE_TTL_MINUTES = 10;

interface GoogleTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  id_token?: string;
}

interface GoogleUserInfo {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
}

export async function googleAuthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /v1/auth/google/start
   *
   * Initiates the Google OAuth flow. Generates a wh_os_ state, persists it
   * in the DB for CSRF validation at callback, then redirects to Google.
   *
   * Requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to be configured.
   */
  app.get('/google/start', async (request, reply) => {
    if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) {
      sendError(reply, 501, ErrorCode.INTERNAL_ERROR, 'Google OAuth is not configured');
      return;
    }

    const stateToken = generateToken('wh_os_');
    const expiresAt = addMinutes(nowUtc(), OAUTH_STATE_TTL_MINUTES);

    // returnTo can be passed as a query param for post-auth redirect.
    const query = request.query as Record<string, string>;
    const returnTo = typeof query.return_to === 'string' ? query.return_to : '/sites';

    await db.insert(oauthState).values({
      state: stateToken,
      expiresAt,
      returnTo,
    });

    const params = new URLSearchParams({
      client_id: config.GOOGLE_CLIENT_ID,
      redirect_uri: `${config.SITE_URL}/v1/auth/google/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      state: stateToken,
      access_type: 'online',
      prompt: 'select_account',
    });

    return reply.code(302).redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`);
  });

  /**
   * GET /v1/auth/google/callback
   *
   * Handles the Google OAuth callback. Validates the state, exchanges the
   * authorization code for tokens, fetches user info, then finds or creates
   * the Site Owner account before issuing a dashboard session.
   */
  app.get('/google/callback', async (request, reply) => {
    if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) {
      sendError(reply, 501, ErrorCode.INTERNAL_ERROR, 'Google OAuth is not configured');
      return;
    }

    const query = request.query as Record<string, string>;
    const { code, state, error: oauthError } = query;

    // Google returns an error param when the user denies access.
    if (oauthError) {
      return reply.code(302).redirect(`${config.SITE_URL}/login?error=google_denied`);
    }

    if (!code || !state) {
      return reply.code(302).redirect(`${config.SITE_URL}/login?error=oauth_invalid`);
    }

    const now = nowUtc();

    // Validate state — prevents CSRF.
    const [stateRow] = await db
      .select()
      .from(oauthState)
      .where(
        and(
          eq(oauthState.state, state),
          gt(oauthState.expiresAt, now),
          isNull(oauthState.consumedAt),
        ),
      )
      .limit(1);

    if (!stateRow) {
      request.log.warn(
        { event: 'oauth_state_invalid', state: state.slice(0, 16) },
        'OAuth callback received invalid or expired state',
      );
      return reply.code(302).redirect(`${config.SITE_URL}/login?error=oauth_invalid`);
    }

    // Consume the state to prevent replay.
    await db
      .update(oauthState)
      .set({ consumedAt: now })
      .where(eq(oauthState.id, stateRow.id));

    // Exchange authorization code for access token.
    let tokenData: GoogleTokenResponse;
    try {
      const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: config.GOOGLE_CLIENT_ID,
          client_secret: config.GOOGLE_CLIENT_SECRET,
          redirect_uri: `${config.SITE_URL}/v1/auth/google/callback`,
          grant_type: 'authorization_code',
        }),
      });

      if (!tokenRes.ok) {
        const errBody = await tokenRes.text();
        request.log.error({ event: 'oauth_token_exchange_error', body: errBody }, 'Google token exchange failed');
        return reply.code(302).redirect(`${config.SITE_URL}/login?error=oauth_failed`);
      }

      tokenData = (await tokenRes.json()) as GoogleTokenResponse;
    } catch (err) {
      request.log.error({ err }, 'Google token exchange threw');
      return reply.code(302).redirect(`${config.SITE_URL}/login?error=oauth_failed`);
    }

    // Fetch user info.
    let userInfo: GoogleUserInfo;
    try {
      const userRes = await fetch(GOOGLE_USERINFO_URL, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });

      if (!userRes.ok) {
        return reply.code(302).redirect(`${config.SITE_URL}/login?error=oauth_failed`);
      }

      userInfo = (await userRes.json()) as GoogleUserInfo;
    } catch (err) {
      request.log.error({ err }, 'Google userinfo fetch threw');
      return reply.code(302).redirect(`${config.SITE_URL}/login?error=oauth_failed`);
    }

    if (!userInfo.email || !userInfo.email_verified) {
      return reply.code(302).redirect(`${config.SITE_URL}/login?error=google_unverified_email`);
    }

    // Find or create the Site Owner.
    let ownerId: string;

    // Try by google_sub first (fastest path for returning users).
    const [byGoogleSub] = await db
      .select({ id: siteOwners.id, authMethod: siteOwners.authMethod })
      .from(siteOwners)
      .where(eq(siteOwners.googleSub, userInfo.sub))
      .limit(1);

    if (byGoogleSub) {
      ownerId = byGoogleSub.id;
      await db
        .update(siteOwners)
        .set({ lastLoginAt: now })
        .where(eq(siteOwners.id, ownerId));
    } else {
      // Try by email — link existing password account.
      const [byEmail] = await db
        .select({ id: siteOwners.id, authMethod: siteOwners.authMethod })
        .from(siteOwners)
        .where(eq(siteOwners.email, userInfo.email))
        .limit(1);

      if (byEmail) {
        ownerId = byEmail.id;
        // Upgrade auth_method: password → both, google stays google.
        const newAuthMethod =
          byEmail.authMethod === 'password' ? 'both' : byEmail.authMethod;
        await db
          .update(siteOwners)
          .set({
            googleSub: userInfo.sub,
            authMethod: newAuthMethod,
            // Email is already verified by Google — ensure flag is set.
            emailVerifiedAt: now,
            lastLoginAt: now,
          })
          .where(eq(siteOwners.id, ownerId));
      } else {
        // Brand-new Site Owner via Google.
        const [newOwner] = await db
          .insert(siteOwners)
          .values({
            email: userInfo.email,
            googleSub: userInfo.sub,
            authMethod: 'google',
            displayName: userInfo.name ?? null,
            emailVerifiedAt: now, // Google already verified this.
            lastLoginAt: now,
          })
          .returning({ id: siteOwners.id });

        if (!newOwner) {
          request.log.error({ event: 'oauth_create_owner_failed' }, 'INSERT site_owner returned no row');
          return reply.code(302).redirect(`${config.SITE_URL}/login?error=oauth_failed`);
        }

        ownerId = newOwner.id;
      }
    }

    // Issue dashboard session.
    const rawSessionToken = generateToken('wh_dsess_');
    const sessionTokenHash = hashToken(rawSessionToken);
    const expiresAt = addDays(now, 30);

    const [session] = await db
      .insert(siteOwnerSessions)
      .values({
        siteOwnerId: ownerId,
        tokenHash: sessionTokenHash,
        expiresAt,
        ipHash: hashBytes(request.ip),
        userAgentHash: hashBytes(request.headers['user-agent'] ?? ''),
      })
      .returning({ id: siteOwnerSessions.id });

    if (!session) {
      request.log.error({ event: 'oauth_session_create_failed', ownerId }, 'INSERT site_owner_session returned no row');
      return reply.code(302).redirect(`${config.SITE_URL}/login?error=oauth_failed`);
    }

    const rawCsrfToken = randomBytes(32).toString('base64url');
    void reply.header('Set-Cookie', buildOwnerSessionCookie(rawSessionToken));
    void reply.header('Set-Cookie', buildCsrfCookie(rawCsrfToken));

    request.log.info(
      { event: 'oauth_login_success', ownerId, sessionId: session.id },
      'Site Owner authenticated via Google',
    );

    const returnTo = stateRow.returnTo ?? '/dashboard';
    return reply.code(302).redirect(`${config.SITE_URL}${returnTo}`);
  });
}
