/**
 * /me/archived — shown after a successful "close and archive" operation.
 *
 * Intentionally generic — does NOT mention the user's email or any identifying
 * information. The user's data has been archived; there is nothing to display.
 *
 * Server Component: no data fetching, no auth required.
 */

import Link from 'next/link';

export default function ArchivedPage() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="max-w-md text-center space-y-6">
        <div className="text-4xl" aria-hidden>
          ✓
        </div>

        <h1 className="text-2xl font-semibold">Your data has been archived</h1>

        <p className="text-muted-foreground text-sm leading-relaxed">
          Your account and sessions have been removed. An anonymised record is retained for
          security purposes and will be purged after 24 months.
        </p>

        <p className="text-muted-foreground text-sm">
          If you return with the same email address in the future, a brand-new account will be
          created with no link to this one.
        </p>

        <p className="text-xs text-muted-foreground">
          Questions?{' '}
          <a
            href="mailto:support@wiredhowse.app"
            className="underline hover:no-underline"
          >
            Contact support
          </a>
          .
        </p>
      </div>
    </div>
  );
}
