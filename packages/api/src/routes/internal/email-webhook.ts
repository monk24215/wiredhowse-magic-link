/**
 * POST /v1/internal/email-webhook
 *
 * Receives bounce, complaint, and delivery-delay events from Resend.
 * Resend signs webhooks using the svix protocol (HMAC-SHA256).
 *
 * Configure in the Resend dashboard:
 *   Endpoint: https://magic-link.wiredhowse.app/v1/internal/email-webhook
 *   Events:   email.bounced, email.complained, email.delivery_delayed
 *   Secret:   copy the signing secret → RESEND_WEBHOOK_SECRET env var
 *
 * MVP scope: log events only.  A suppression list that hard-blocks bounced
 * addresses lands in v1.1 once we see real bounce patterns.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from '../../config';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ResendWebhookEvent {
  type: 'email.bounced' | 'email.complained' | 'email.delivery_delayed' | string;
  data: {
    email_id: string;
    bounce?: { message: string; type?: string };
    [key: string]: unknown;
  };
  created_at: string;
}

// The scoped content-type parser attaches both the raw Buffer and the parsed
// event so the route handler can run HMAC verification on the exact bytes
// Resend sent (re-serialising would risk whitespace / key-order mismatches).
interface ParsedBody {
  _raw: Buffer;
  _event: ResendWebhookEvent;
}

// ── Signature verification ────────────────────────────────────────────────────

/**
 * Verifies a Resend svix-style webhook signature.
 *
 * Resend's signing algorithm:
 *   1. Construct: `${svix-id}.${svix-timestamp}.${raw-body-string}`
 *   2. HMAC-SHA256 with the base64-decoded secret (secret may be prefixed "whsec_")
 *   3. The svix-signature header contains one or more space-separated "v1,<base64>" entries.
 *
 * See: https://docs.resend.com/changelog/webhooks
 */
function verifyResendSignature(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
): boolean {
  const svixId = headers['svix-id'];
  const svixTs = headers['svix-timestamp'];
  const svixSig = headers['svix-signature'];

  const id = Array.isArray(svixId) ? (svixId[0] ?? '') : (svixId ?? '');
  const ts = Array.isArray(svixTs) ? (svixTs[0] ?? '') : (svixTs ?? '');
  const sig = Array.isArray(svixSig) ? (svixSig[0] ?? '') : (svixSig ?? '');

  if (!id || !ts || !sig) return false;

  // Reject timestamps older than 5 minutes — prevents replay attacks.
  const ageSec = Math.abs(Date.now() / 1000 - Number(ts));
  if (ageSec > 300) return false;

  // Resend prefixes secrets with "whsec_" and base64-encodes them.
  const secretBytes = secret.startsWith('whsec_')
    ? Buffer.from(secret.slice(6), 'base64')
    : Buffer.from(secret, 'base64');

  const toSign = `${id}.${ts}.${rawBody.toString('utf8')}`;
  const expected = createHmac('sha256', secretBytes).update(toSign).digest('base64');

  // svix-signature may contain multiple space-separated "v1,<base64>" entries
  // to support key rotation (any one valid entry is sufficient).
  const candidates = sig.split(' ').map((s) => s.replace(/^v1,/, ''));

  return candidates.some((candidate) => {
    if (candidate.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
  });
}

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function emailWebhookRoutes(app: FastifyInstance): Promise<void> {
  // Override the JSON content-type parser for this plugin scope only.
  // Captures the raw body Buffer alongside the parsed JSON so we can verify
  // the HMAC signature on the exact bytes Resend signed.
  // Fastify plugin encapsulation ensures this parser does NOT affect any other
  // routes — it is scoped to this registered plugin instance.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_req, body: Buffer, done) => {
      try {
        const _event = JSON.parse(body.toString('utf8')) as ResendWebhookEvent;
        done(null, { _raw: body, _event } satisfies ParsedBody);
      } catch {
        done(new Error('Invalid JSON in webhook payload'), undefined);
      }
    },
  );

  app.post('/email-webhook', async (request, reply) => {
    const { _raw: rawBody, _event: event } = request.body as ParsedBody;

    // ── Signature verification ───────────────────────────────────────────────
    if (config.RESEND_WEBHOOK_SECRET) {
      const headers = request.headers as Record<string, string | string[] | undefined>;
      const valid = verifyResendSignature(rawBody, headers, config.RESEND_WEBHOOK_SECRET);

      if (!valid) {
        request.log.warn(
          { event: 'resend_webhook_sig_invalid' },
          'Resend webhook signature verification failed — rejecting request',
        );
        return reply.code(401).send({ error: 'Invalid signature' });
      }
    } else {
      request.log.warn(
        { event: 'resend_webhook_no_secret' },
        'RESEND_WEBHOOK_SECRET not configured — skipping signature check (set before launch)',
      );
    }

    // ── Event handling ───────────────────────────────────────────────────────
    const { type, data } = event;

    switch (type) {
      case 'email.bounced':
        // Hard bounces reduce sender reputation fast.  Log loudly.
        // v1.1: write to email_suppressions table to block future sends.
        request.log.warn(
          { event: 'resend_bounce', emailId: data.email_id, bounce: data.bounce },
          'Email hard-bounced — add to suppression list in v1.1',
        );
        break;

      case 'email.complained':
        // Spam complaints are critical.  Log at error level.
        request.log.error(
          { event: 'resend_complaint', emailId: data.email_id },
          'Spam complaint received — investigate sending patterns immediately',
        );
        break;

      case 'email.delivery_delayed':
        request.log.warn(
          { event: 'resend_delay', emailId: data.email_id },
          'Email delivery delayed (Resend reports >24 h)',
        );
        break;

      default:
        request.log.info(
          { event: 'resend_webhook_unknown', type },
          'Unhandled Resend webhook event type — ignoring',
        );
    }

    return reply.code(200).send({ received: true });
  });
}
