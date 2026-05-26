import { Resend } from 'resend';
import { config } from '../config';

let _resend: Resend | null = null;

function getResend(): Resend {
  if (!_resend) _resend = new Resend(config.RESEND_API_KEY);
  return _resend;
}

interface SendResult {
  id: string;
}

async function send(params: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<SendResult> {
  const from = `${config.EMAIL_FROM_NAME} <${config.RESEND_FROM}>`;

  const { data, error } = await getResend().emails.send({
    from,
    to: [params.to],
    replyTo: config.EMAIL_REPLY_TO,
    subject: params.subject,
    html: params.html,
    text: params.text,
  });

  if (error || !data) {
    throw new Error(`Resend send failed: ${error?.message ?? 'unknown error'}`);
  }

  return { id: data.id };
}

// ---------------------------------------------------------------------------
// HTML base layout
// ---------------------------------------------------------------------------

function htmlWrap(body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827">
<table width="100%" cellpadding="0" cellspacing="0" role="presentation">
<tr><td align="center" style="padding:48px 16px">
<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:480px;background:#ffffff;border-radius:8px;padding:40px;border:1px solid #e5e7eb">
<tr><td>
<p style="margin:0 0 24px;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#9ca3af">wiredHowse</p>
${body}
<hr style="margin:32px 0;border:none;border-top:1px solid #e5e7eb">
<p style="margin:0;font-size:12px;color:#d1d5db;text-align:center">wiredHowse &mdash; magic-link.wiredhowse.app</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function htmlButton(url: string, label: string): string {
  return `<table cellpadding="0" cellspacing="0" role="presentation" style="margin-bottom:24px">
<tr>
<td style="border-radius:6px;background:#2563eb">
<a href="${url}" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px">${label}</a>
</td>
</tr>
</table>
<p style="margin:0 0 16px;font-size:13px;color:#6b7280">Button not working? Copy this link into your browser:<br>
<a href="${url}" style="color:#2563eb;word-break:break-all">${url}</a></p>`;
}

// ---------------------------------------------------------------------------
// Magic link email
// ---------------------------------------------------------------------------

export interface MagicLinkEmailParams {
  to: string;
  siteDomain: string;
  magicLinkUrl: string;
  expiresInMinutes: number;
}

export async function sendMagicLinkEmail(params: MagicLinkEmailParams): Promise<SendResult> {
  const { to, siteDomain, magicLinkUrl, expiresInMinutes } = params;

  const html = htmlWrap(`
<h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#111827">Sign in to ${siteDomain}</h1>
<p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#374151">
Click the button below to sign in. This link expires in ${expiresInMinutes}&nbsp;minutes and can only be used once.
</p>
${htmlButton(magicLinkUrl, `Sign in to ${siteDomain}`)}
<p style="margin:0;font-size:13px;color:#9ca3af">If you didn't request this link, you can safely ignore this email.</p>`);

  const text = `Sign in to ${siteDomain}

Click the link below to sign in. This link expires in ${expiresInMinutes} minutes and can only be used once.

  ${magicLinkUrl}

If you didn't request this, you can safely ignore this email.

— wiredHowse`;

  return send({ to, subject: `Your sign-in link for ${siteDomain}`, html, text });
}

// ---------------------------------------------------------------------------
// Email verification (Site Owner signup)
// ---------------------------------------------------------------------------

export interface EmailVerificationParams {
  to: string;
  verifyUrl: string;
  expiresInHours: number;
}

export async function sendEmailVerificationEmail(
  params: EmailVerificationParams,
): Promise<SendResult> {
  const { to, verifyUrl, expiresInHours } = params;

  const html = htmlWrap(`
<h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#111827">Verify your email</h1>
<p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#374151">
Click the button below to verify your email address and activate your wiredHowse account.
This link expires in ${expiresInHours}&nbsp;hours.
</p>
${htmlButton(verifyUrl, 'Verify email address')}
<p style="margin:0;font-size:13px;color:#9ca3af">If you didn't create a wiredHowse account, you can safely ignore this email.</p>`);

  const text = `Verify your wiredHowse email

Click the link below to verify your email address. This link expires in ${expiresInHours} hours.

  ${verifyUrl}

If you didn't create a wiredHowse account, you can safely ignore this email.

— wiredHowse`;

  return send({ to, subject: 'Verify your wiredHowse email', html, text });
}

// ---------------------------------------------------------------------------
// Password reset (Site Owner)
// ---------------------------------------------------------------------------

export interface PasswordResetEmailParams {
  to: string;
  resetUrl: string;
  expiresInHours: number;
}

export async function sendPasswordResetEmail(
  params: PasswordResetEmailParams,
): Promise<SendResult> {
  const { to, resetUrl, expiresInHours } = params;

  const html = htmlWrap(`
<h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#111827">Reset your password</h1>
<p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#374151">
Click the button below to reset your wiredHowse password.
This link expires in ${expiresInHours}&nbsp;hour${expiresInHours === 1 ? '' : 's'}.
</p>
${htmlButton(resetUrl, 'Reset password')}
<p style="margin:0;font-size:13px;color:#9ca3af">If you didn't request a password reset, you can safely ignore this email. Your password has not been changed.</p>`);

  const text = `Reset your wiredHowse password

Click the link below to reset your password. This link expires in ${expiresInHours} hour${expiresInHours === 1 ? '' : 's'}.

  ${resetUrl}

If you didn't request a password reset, you can safely ignore this email. Your password has not been changed.

— wiredHowse`;

  return send({ to, subject: 'Reset your wiredHowse password', html, text });
}
