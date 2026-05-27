import type { ReactNode } from 'react';

/**
 * Centered single-column layout for auth pages (login, signup, etc.).
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-muted flex flex-col items-center justify-center px-4 py-12">
      <div className="mb-8 text-center">
        <span className="text-xs font-semibold tracking-widest uppercase text-muted-foreground">
          wiredHowse
        </span>
      </div>
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}
