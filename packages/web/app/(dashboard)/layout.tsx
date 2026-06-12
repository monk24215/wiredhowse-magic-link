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
    <div className="bg-yellow-50 border-b border-yellow-200 px-6 py-3">
      <p className="text-sm text-yellow-800">
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
  <aside className="w-56 border-r bg-background flex flex-col p-4 gap-1 shrink-0">
    <div className="mb-6">
      <img
        src="https://magic-link.wiredhowse.app/logo.png"
        alt="wiredHowse"
        className="h-8 w-auto mb-3"/>
      <span className="text-xs font-semibold tracking-widest uppercase text-muted-foreground">
        wiredHowse
      </span>
      <p className="text-xs text-muted-foreground mt-1 truncate">{profile.email}</p>
    </div>
    <nav className="flex flex-col gap-1">
      <Link href="/sites"
        className="px-3 py-2 text-sm rounded-md hover:bg-muted transition-colors">
        Sites
      </Link>
      <Link
        href="/account"
        className="px-3 py-2 text-sm rounded-md hover:bg-muted transition-colors"
      >
        Account
      </Link>
    </nav>
    <div className="mt-auto">
      <SignOutButton />
    </div>
  </aside>
  <main className="flex-1 overflow-auto">
    {!emailVerified && <UnverifiedBanner />}
    <div className="p-6">{children}</div>
  </main>
</div>

    
  );
}
