import { db, siteOwners, sessions, sites } from '@wiredhowse/db';
import { and, countDistinct, eq, gt, sql } from 'drizzle-orm';
import { PLAN_LIMITS } from '../lib/plans';

/**
 * Returns whether the owner's sites are still under their plan's monthly
 * active End User cap (distinct End Users with a session created in the last 30 days).
 */
export async function checkMonthlyUserCap(
  siteOwnerId: string,
): Promise<{ allowed: boolean; plan: 'free' | 'pro'; used: number; limit: number }> {
  const [owner] = await db
    .select({ plan: siteOwners.plan })
    .from(siteOwners)
    .where(eq(siteOwners.id, siteOwnerId))
    .limit(1);
  const plan = owner?.plan ?? 'free';
  const limit = PLAN_LIMITS[plan].monthlyUsers;

  const [row] = await db
    .select({ used: countDistinct(sessions.endUserId) })
    .from(sessions)
    .innerJoin(sites, eq(sessions.siteId, sites.id))
    .where(
      and(
        eq(sites.siteOwnerId, siteOwnerId),
        gt(sessions.createdAt, sql`now() - interval '30 days'`),
      ),
    );

  const used = Number(row?.used ?? 0);
  return { allowed: used < limit, plan, used, limit };
}
