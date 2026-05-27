'use client';

export function SignOutButton() {
  async function handleSignOut() {
    await fetch('/api/v1/auth/logout', { method: 'POST', credentials: 'include' });
    window.location.href = '/login';
  }

  return (
    <button
      type="button"
      onClick={handleSignOut}
      className="w-full text-left px-3 py-2 text-sm rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
    >
      Sign out
    </button>
  );
}
