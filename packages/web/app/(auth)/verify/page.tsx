'use client';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, api } from '@/lib/api';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

type State = 'loading' | 'success' | 'error' | 'missing_token';

function VerifyContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const [state, setState] = useState<State>(token ? 'loading' : 'missing_token');
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    if (!token) return;

    let cancelled = false;

    api
      .post('/auth/verify-email', { token })
      .then(() => {
        if (!cancelled) setState('success');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError) {
          setErrorMessage(
            err.code === 'INVALID_TOKEN'
              ? 'This verification link is invalid or has expired. Please request a new one by signing up again.'
              : 'Something went wrong verifying your email. Please try again.',
          );
        } else {
          setErrorMessage('Something went wrong. Please try again.');
        }
        setState('error');
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  if (state === 'loading') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Verifying your email…</CardTitle>
          <CardDescription>Please wait a moment.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center h-8">
            <div className="h-5 w-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (state === 'success') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Email verified</CardTitle>
          <CardDescription>Your account is ready. You can now log in.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild className="w-full">
            <Link href="/login">Continue to login</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (state === 'missing_token') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Invalid link</CardTitle>
          <CardDescription>No verification token was found in this URL.</CardDescription>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <AlertDescription>
              Please use the link from your verification email. If you need a new link, sign up
              again.
            </AlertDescription>
          </Alert>
          <div className="mt-4">
            <Button asChild variant="outline" className="w-full">
              <Link href="/signup">Back to sign up</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Verification failed</CardTitle>
      </CardHeader>
      <CardContent>
        <Alert variant="destructive">
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
        <div className="mt-4 space-y-2">
          <Button asChild variant="outline" className="w-full">
            <Link href="/signup">Sign up again</Link>
          </Button>
          <Button asChild variant="ghost" className="w-full">
            <Link href="/login">Back to login</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function VerifyPage() {
  return (
    <Suspense
      fallback={
        <Card>
          <CardHeader>
            <CardTitle>Loading…</CardTitle>
          </CardHeader>
        </Card>
      }
    >
      <VerifyContent />
    </Suspense>
  );
}
