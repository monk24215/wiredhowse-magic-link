import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config', () => ({
  config: { STRIPE_SECRET_KEY: undefined },
}));

import { PLAN_LIMITS, getStripe, planForSubscriptionStatus } from '../../src/lib/plans';

describe('planForSubscriptionStatus', () => {
  it('maps active and trialing to pro', () => {
    expect(planForSubscriptionStatus('active')).toBe('pro');
    expect(planForSubscriptionStatus('trialing')).toBe('pro');
  });

  it('maps every other status to free', () => {
    for (const status of ['past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired']) {
      expect(planForSubscriptionStatus(status)).toBe('free');
    }
  });
});

describe('PLAN_LIMITS', () => {
  it('free is 3 sites / 500 users, pro is 10 sites / 10,000 users', () => {
    expect(PLAN_LIMITS.free).toEqual({ sites: 3, monthlyUsers: 500 });
    expect(PLAN_LIMITS.pro).toEqual({ sites: 10, monthlyUsers: 10_000 });
  });
});

describe('getStripe', () => {
  it('returns null when STRIPE_SECRET_KEY is absent', () => {
    expect(getStripe()).toBeNull();
  });
});
