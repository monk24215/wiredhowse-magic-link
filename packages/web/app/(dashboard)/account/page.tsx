import { ServerApiError, serverApi } from '@/lib/server-api';
import { AccountForm } from './account-form';

interface AccountProfile {
  id: string;
  email: string;
  display_name: string | null;
  email_verified_at: string | null;
  auth_method: 'password' | 'google' | 'both';
}

export default async function AccountPage() {
  let profile: AccountProfile;

  try {
    profile = await serverApi.get<AccountProfile>('/dashboard/account');
  } catch (err) {
    if (err instanceof ServerApiError) {
      // 401 is handled by the layout; surface other errors
      throw err;
    }
    throw err;
  }

  return (
    <div className="max-w-lg mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Account</h1>
        <p className="text-sm text-muted-foreground mt-1">Manage your profile and password.</p>
      </div>

      <AccountForm profile={profile} />
    </div>
  );
}
