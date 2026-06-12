import { ServerApiError, serverApi } from '@/lib/server-api';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { SignOutButton } from './sign-out-button';

interface AccountProfile {
  id: string;
  email: string;
  display_name: string | null;
  email_verified_at: string | null;
  auth_method: string;
}

function UnverifiedBanner() {
  return (
    <div className="border-b border-amber-500/30 bg-amber-500/10 px-6 py-3">
      <p className="text-sm text-amber-400">
        Your email is not verified. Sites cannot go live until you verify. Check your inbox.
      </p>
    </div>
  );
}

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  let profile: AccountProfile;

  try {
    profile = await serverApi.get<AccountProfile>('/dashboard/account');
  } catch (err) {
    if (err instanceof ServerApiError && err.status === 401) {
      redirect('/login');
    }
    throw err;
  }

  const emailVerified = profile.email_verified_at !== null;

  return (
    <div className="flex min-h-screen">
      {/* Sidebar — relative + overflow-hidden so the background logo is clipped to it */}
      <aside className="w-56 border-r border-border bg-muted flex flex-col p-4 gap-1 shrink-0 relative overflow-hidden">

        {/* Background watermark logo — large, fixed in place, very low opacity */}
        <div
          className="pointer-events-none select-none"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 0,
          }}
          aria-hidden="true"
        >
          <img
            src="https://magic-link.wiredhowse.app/logo.png"
            alt=""
            style={{
              width: '810px',
              maxWidth: '810px',
              opacity: 0.045,
              userSelect: 'none',
            }}
          />
        </div>

        {/* All sidebar content sits above the watermark */}
        <div className="relative z-10 flex flex-col flex-1 gap-1">
          {/* Brand block — logo (2× size) centered above the eyebrow label */}
          <div className="mb-6 flex flex-col items-center text-center">
            <img
              src="https://magic-link.wiredhowse.app/logo.png"
              alt="wiredHowse"
              className="h-16 w-auto mb-3"
            />
            {/* Eyebrow label — matches .eyebrow from the design system */}
            <span
              className="font-mono uppercase"
              style={{
                fontSize: '12px',
                letterSpacing: '0.18em',
                color: '#ffb494',
              }}
            >
              wiredHowse
            </span>
            <p className="text-xs text-muted-foreground mt-1 truncate max-w-full px-1">
              {profile.email}
            </p>
          </div>

          <nav className="flex flex-col gap-1">
            <Link
              href="/sites"
              className="px-3 py-2 text-sm rounded-md text-muted-foreground hover:bg-[#1d2026] hover:text-foreground transition-colors"
            >
              Sites
            </Link>
            <Link
              href="/account"
              className="px-3 py-2 text-sm rounded-md text-muted-foreground hover:bg-[#1d2026] hover:text-foreground transition-colors"
            >
              Account
            </Link>
          </nav>

          <div className="mt-auto">
            <SignOutButton />
          </div>
        </div>
      </aside>

      <main className="flex-1 overflow-auto">
        {!emailVerified && <UnverifiedBanner />}
        <div className="p-6">{children}</div>
      </main>
    </div>
  );
}
