// Masks an email for display: first char + *** + last char of local + @ + domain.
// "alice@example.com" → "a***e@example.com"
// "a@example.com"     → "a***@example.com"
export function maskEmail(email: string): string {
  const atIdx = email.lastIndexOf('@');
  if (atIdx <= 0) return '***@***';
  const local = email.slice(0, atIdx);
  const domain = email.slice(atIdx + 1);
  if (local.length <= 1) return `${local}***@${domain}`;
  return `${local[0]}***${local[local.length - 1]}@${domain}`;
}
