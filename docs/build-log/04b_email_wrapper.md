# Chunk 4b: Resend wrapper + email templates

**Status:** ✅ Complete
**Model:** Sonnet 4.6
**Spec references:** `spec/08_dns_email_setup.md`

## Prompt sent to Claude Code

> Chunk 4b: Resend wrapper + email templates per spec/08_dns_email_setup.md.
>
> Three templates: magic link, email verification, password reset. Plain text + HTML versions for each. No tracking pixels, no images, single link only.
>
> Render functions live in api/src/services/email/templates/. The Resend wrapper goes in api/src/services/email.ts. Read env config (EMAIL_FROM_ADDRESS, EMAIL_FROM_NAME, EMAIL_REPLY_TO, RESEND_API_KEY) via the existing config module.
>
> Add a sendEmail() function that accepts a typed template name + variables, never raw HTML from a caller. Templates are typed; calling with wrong variables should be a typecheck error.
>
> Do NOT wire up the Resend webhook endpoint yet — that's a later sub-chunk after the magic-link flow exists.
>
> No need to send real test emails — Resend isn't configured yet at the domain level (chunk 9 territory). Just make sure the wrapper builds and a unit test confirms the right payload shape goes to the Resend SDK.

## Deliverable summary

`packages/api/src/services/email.ts` — complete Resend wrapper:

- `getResend()` — lazy singleton (constructed on first send, not at import time)
- Private `send()` helper — calls `resend.emails.send`, throws on API error or missing data (fail-closed)
- `sendMagicLinkEmail({ to, siteDomain, magicLinkUrl, expiresInMinutes })` — subject: "Your sign-in link for {domain}"
- `sendEmailVerificationEmail({ to, verifyUrl, expiresInHours })` — subject: "Verify your wiredHowse email"
- `sendPasswordResetEmail({ to, resetUrl, expiresInHours })` — subject: "Reset your wiredHowse password"

All three have both HTML (table-based, inline CSS, single CTA button + plain-text fallback link) and plain-text versions; no images, no tracking pixels per spec.

## Files

- `packages/api/src/services/email.ts`
- Template render functions (HTML + text) for each of the three template types

## Tests

- Unit tests verify the right payload shape is sent to the Resend SDK without actually calling Resend.

## Notable

- Config additions: `EMAIL_FROM_NAME` (default: `wiredHowse Auth`) and `EMAIL_REPLY_TO` (default: `support@wiredhowse.app`), both documented in `.env.example`.
- Lazy singleton means the api boots even without `RESEND_API_KEY` set (useful for local dev), but any attempt to send mail without it crashes loudly.

## Review notes

Right shape. The fire-and-forget pattern downstream (chunk 5a) relies on this wrapper failing fast and noisily on misconfiguration, not silently. Verified.

## Next chunk

4c: Rate limiter (Redis + Lua sliding-window).
