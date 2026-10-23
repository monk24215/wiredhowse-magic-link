import Stripe from 'stripe';
import { config } from '../config';

export type PlanName = 'free' | 'pro';

export const PLAN_LIMITS: Record<PlanName, { sites: number; monthlyUsers: number }> = {
  free: { sites: 3, monthlyUsers: 500 },
  pro: { sites: 10, monthlyUsers: 10_000 },
};

/** Maps a Stripe subscription status to the plan it entitles the owner to. */
export function planForSubscriptionStatus(status: string): PlanName {
  return status === 'active' || status === 'trialing' ? 'pro' : 'free';
}

let stripeClient: Stripe | null = null;

/** Returns the Stripe client, or null when billing is not configured. */
export function getStripe(): Stripe | null {
  if (!config.STRIPE_SECRET_KEY) return null;
  stripeClient ??= new Stripe(config.STRIPE_SECRET_KEY);
  return stripeClient;
}
