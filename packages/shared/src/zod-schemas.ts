import { z } from 'zod';

export const emailSchema = z.string().email().max(254).toLowerCase();

export const siteKeySchema = z.string().regex(/^pk_[A-Za-z0-9_-]{22,}$/, 'Invalid site key');

export const magicLinkRequestSchema = z.object({
  email: emailSchema,
  siteKey: siteKeySchema,
});

export const handoffExchangeSchema = z.object({
  handoffToken: z.string().regex(/^wh_ho_/, 'Invalid handoff token'),
  siteKey: siteKeySchema,
});

export const sessionCheckSchema = z.object({
  siteKey: siteKeySchema,
});

export const signOutSchema = z.object({
  siteKey: siteKeySchema,
});
