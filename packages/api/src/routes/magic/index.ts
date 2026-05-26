import type { FastifyInstance } from 'fastify';
import { magicPreflightRoutes } from './preflight';
import { magicRedeemRoutes } from './redeem';

export async function magicRoutes(app: FastifyInstance): Promise<void> {
  await app.register(magicPreflightRoutes);
  await app.register(magicRedeemRoutes);
}
