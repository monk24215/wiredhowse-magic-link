import { db, siteOwners } from '@wiredhowse/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';
import { config } from '../../config';
import { getStripe, planForSubscriptionStatus } from '../../lib/plans';

/**
 * Stripe webhook receiver. Registered as its own plugin so the JSON parser
 * override below keeps the raw body (needed for signature verification)
 * without affecting any other route.
 */
export async function stripeWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body),
  );

  app.post('/stripe-webhook', async (request, reply) => {
    const stripe = getStripe();
    if (!stripe || !config.STRIPE_WEBHOOK_SECRET) {
      return reply.code(501).send({ error: 'Stripe webhook not configured' });
    }

    const signature = request.headers['stripe-signature'];
    if (typeof signature !== 'string') {
      return reply.code(400).send({ error: 'Missing signature' });
    }

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        request.body as Buffer,
        signature,
        config.STRIPE_WEBHOOK_SECRET,
      );
    } catch {
      return reply.code(400).send({ error: 'Invalid signature' });
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode !== 'subscription' || !session.client_reference_id) break;
        await db
          .update(siteOwners)
          .set({
            plan: 'pro',
            planStatus: 'active',
            stripeCustomerId: typeof session.customer === 'string' ? session.customer : null,
            stripeSubscriptionId:
              typeof session.subscription === 'string' ? session.subscription : null,
          })
          .where(eq(siteOwners.id, session.client_reference_id));
        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const periodEnd = sub.current_period_end;
        await db
          .update(siteOwners)
          .set({
            plan: planForSubscriptionStatus(sub.status),
            planStatus: sub.status,
            planPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
          })
          .where(eq(siteOwners.stripeSubscriptionId, sub.id));
        break;
      }
      default:
        break;
    }

    return reply.code(200).send({ received: true });
  });
}
