import { z } from 'zod';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const emailSchema = z.string().email().max(254).toLowerCase();

export const siteKeyHeaderSchema = z.string().regex(/^pk_[A-Za-z0-9_-]{22,}$/, 'Invalid site key');

const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password too long');

const domainSchema = z
  .string()
  .min(3)
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, 'Invalid domain');

// ---------------------------------------------------------------------------
// /v1/snippet/session/check
// ---------------------------------------------------------------------------

export const sessionCheckBodySchema = z
  .object({ token: z.string().optional() })
  .optional()
  .default({});

// ---------------------------------------------------------------------------
// /v1/snippet/magic-link/request
// ---------------------------------------------------------------------------

export const magicLinkRequestSchema = z.object({
  email: emailSchema,
});

// ---------------------------------------------------------------------------
// /v1/snippet/handoff/exchange
// ---------------------------------------------------------------------------

export const handoffExchangeSchema = z.object({
  handoff_token: z.string().regex(/^wh_ho_[A-Za-z0-9_-]+$/, 'Invalid handoff token'),
});

// ---------------------------------------------------------------------------
// /v1/me
// ---------------------------------------------------------------------------

export const updateMeSchema = z.object({
  display_name: z.string().max(100).nullable().optional(),
});

// ---------------------------------------------------------------------------
// /v1/me/close-and-archive
// ---------------------------------------------------------------------------

export const closeAndArchiveSchema = z.object({
  confirmation: z.literal('DELETE MY DATA'),
});

// ---------------------------------------------------------------------------
// /v1/auth/*
// ---------------------------------------------------------------------------

export const signupSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1),
});

export const verifyEmailSchema = z.object({
  token: z.string().regex(/^wh_ev_[A-Za-z0-9_-]+$/, 'Invalid verification token'),
});

export const requestPasswordResetSchema = z.object({
  email: emailSchema,
});

export const resetPasswordSchema = z.object({
  token: z.string().regex(/^wh_pr_[A-Za-z0-9_-]+$/, 'Invalid reset token'),
  new_password: passwordSchema,
});

// ---------------------------------------------------------------------------
// /v1/dashboard/*
// ---------------------------------------------------------------------------

export const createSiteSchema = z.object({
  domain: domainSchema,
});

// Normalizes any URL to just its origin (scheme + host + port).
// Rejects non-http/https schemes and unparseable strings.
const originSchema = z.string().transform((val, ctx) => {
  let parsed: URL;
  try {
    parsed = new URL(val);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid origin URL' });
    return z.NEVER;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Origin must use http or https' });
    return z.NEVER;
  }
  const normalized = parsed.origin;
  if (normalized === 'null') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid origin' });
    return z.NEVER;
  }
  return normalized;
});

export const updateSiteSchema = z
  .object({
    allowed_origins: z.array(originSchema).max(20).optional(),
    state: z.enum(['live', 'disabled']).optional(),
  })
  .refine((v) => v.allowed_origins !== undefined || v.state !== undefined, {
    message: 'At least one field must be provided',
  });

export const updateAccountSchema = z
  .object({
    display_name: z.string().max(100).nullable().optional(),
    current_password: z.string().optional(),
    new_password: passwordSchema.optional(),
  })
  .refine(
    (v) => {
      if (v.new_password !== undefined && v.current_password === undefined) return false;
      return true;
    },
    { message: 'current_password is required when setting new_password' },
  );
