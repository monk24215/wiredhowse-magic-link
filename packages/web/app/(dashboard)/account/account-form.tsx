'use client';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, api } from '@/lib/api';
import { useState } from 'react';

interface AccountProfile {
  id: string;
  email: string;
  display_name: string | null;
  email_verified_at: string | null;
  auth_method: 'password' | 'google' | 'both';
}

const AUTH_METHOD_LABEL: Record<AccountProfile['auth_method'], string> = {
  password: 'Password',
  google: 'Google',
  both: 'Password + Google',
};

interface AccountFormProps {
  profile: AccountProfile;
}

export function AccountForm({ profile }: AccountFormProps) {
  const [displayName, setDisplayName] = useState(profile.display_name ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const showPasswordSection = profile.auth_method === 'password' || profile.auth_method === 'both';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    // Validate password fields if the user is changing password
    if (showPasswordSection && newPassword) {
      if (newPassword.length < 8) {
        setError('New password must be at least 8 characters.');
        return;
      }
      if (newPassword !== confirmPassword) {
        setError('New passwords do not match.');
        return;
      }
      if (!currentPassword) {
        setError('Enter your current password to set a new one.');
        return;
      }
    }

    setLoading(true);

    try {
      const body: {
        display_name?: string;
        current_password?: string;
        new_password?: string;
      } = {};

      if (displayName) body.display_name = displayName;

      if (showPasswordSection && newPassword) {
        body.current_password = currentPassword;
        body.new_password = newPassword;
      }

      await api.patch('/dashboard/account', body);
      setSuccess(true);
      // Clear password fields on success
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'INVALID_CREDENTIALS') {
          setError('Current password is incorrect.');
        } else if (err.code === 'VALIDATION_ERROR') {
          setError(err.message);
        } else {
          setError('Something went wrong. Please try again.');
        }
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {success && (
        <Alert>
          <AlertDescription>Account updated.</AlertDescription>
        </Alert>
      )}

      {/* Profile section */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Profile</CardTitle>
          <CardDescription>Your display name and sign-in details.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="display-name">Display name</Label>
            <Input
              id="display-name"
              type="text"
              placeholder="Your name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoComplete="name"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={profile.email}
              readOnly
              disabled
              className="bg-muted cursor-not-allowed"
            />
            <p className="text-xs text-muted-foreground">Email address cannot be changed.</p>
          </div>

          <div className="space-y-2">
            <Label>Sign-in method</Label>
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-[#e8612c]/15 text-[#ffb494] ring-1 ring-[#e8612c]/30">
                {AUTH_METHOD_LABEL[profile.auth_method]}
              </span>
              {profile.email_verified_at ? (
                <span className="text-xs text-emerald-400">Email verified</span>
              ) : (
                <span className="text-xs text-amber-400">Email not verified</span>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Password section */}
      {showPasswordSection && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Change password</CardTitle>
            <CardDescription>Leave blank to keep your current password.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="current-password">Current password</Label>
              <Input
                id="current-password"
                type="password"
                placeholder="Your current password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="new-password">New password</Label>
              <Input
                id="new-password"
                type="password"
                placeholder="At least 8 characters"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirm-password">Confirm new password</Label>
              <Input
                id="confirm-password"
                type="password"
                placeholder="Repeat new password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
              />
            </div>
          </CardContent>
        </Card>
      )}

      <Button type="submit" disabled={loading}>
        {loading ? 'Saving…' : 'Save changes'}
      </Button>
    </form>
  );
}
