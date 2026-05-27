import type { FastifyInstance } from 'fastify';
import { googleAuthRoutes } from './google';
import { loginRoutes } from './login';
import { logoutRoutes } from './logout';
import { passwordResetRoutes } from './password-reset';
import { signupRoutes } from './signup';
import { verifyEmailRoutes } from './verify-email';

/**
 * Site Owner authentication routes.
 *
 * All routes are registered under the /v1/auth prefix (set in index.ts).
 *
 * Endpoints:
 *   POST   /signup
 *   POST   /login
 *   POST   /logout
 *   POST   /verify-email
 *   POST   /request-password-reset
 *   POST   /reset-password
 *   GET    /google/start
 *   GET    /google/callback
 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  await app.register(signupRoutes);
  await app.register(loginRoutes);
  await app.register(logoutRoutes);
  await app.register(verifyEmailRoutes);
  await app.register(passwordResetRoutes);
  await app.register(googleAuthRoutes);
}
