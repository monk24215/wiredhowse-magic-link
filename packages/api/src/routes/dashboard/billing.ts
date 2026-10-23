import { db, siteOwners } from '@wiredhowse/db';
import { ErrorCode } from '@wiredhowse/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { config } from '../../config';
import { sendError } from '../../errors';
import { getStripe } from '../../lib/plans';

export async function billingRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /v1/dashboard/billing/checkout
   * Starts a Stripe Checkout subscription for the Pro plan. Returns the hosted URL.
   */
  app.post('/checkout', async (request, reply) => {
    const owner = request.siteOwner;
    if (!owner) return;

    const stripe = getStripe();
    if (!stripe || !config.STRIPE_PRICE_PRO) {
      sendError(reply, 501, ErrorCode.BILLING_NOT_CONFIGURED, 'Billing is not configured');
      return;
    }
    if (owner.plan === 'pro' && owner.planStatus === 'active') {
      sendError(reply, 409, ErrorCode.ALREADY_SUBSCRIBED, 'You are already on the Pro plan');
      return;
    }

    let customerId = owner.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: owner.email,
        metadata: { site_owner_id: owner.id },
      });
      customerId = customer.id;
      await db
        .update(siteOwners)
        .set({ stripeCustomerId: customerId })
        .where(eq(siteOwners.id, owner.id));
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: owner.id,
      line_items: [{ price: config.STRIPE_PRICE_PRO, quantity: 1 }],
      subscription_data: { metadata: { site_owner_id: owner.id } },
      success_url: `${config.SITE_URL}/dashboard?billing=success`,
      cancel_url: `${config.SITE_URL}/dashboard?billing=cancelled`,
    });

    return reply.code(200).send({ data: { url: session.url } });
  });

  /**
   * POST /v1/dashboard/billing/portal
   * Opens the Stripe Billing Portal so the owner can change or cancel the plan.
   */
  app.post('/portal', async (request, reply) => {
    const owner = request.siteOwner;
    if (!owner) return;

    const stripe = getStripe();
    if (!stripe) {
      sendError(reply, 501, ErrorCode.BILLING_NOT_CONFIGURED, 'Billing is not configured');
      return;
    }
    if (!owner.stripeCustomerId) {
      sendError(reply, 409, ErrorCode.NO_BILLING_ACCOUNT, 'No billing account yet');
      return;
    }

    const portal = await stripe.billingPortal.sessions.create({
      customer: owner.stripeCustomerId,
      return_url: `${config.SITE_URL}/dashboard`,
    });

    return reply.code(200).send({ data: { url: portal.url } });
  });
}
