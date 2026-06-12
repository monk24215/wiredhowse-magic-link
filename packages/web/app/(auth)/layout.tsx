import type { ReactNode } from 'react';

/**
 * Centered single-column layout for auth pages (login, signup, etc.).
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 py-12">
      <div className="mb-8 text-center">
        <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-[#e46432]">
          wiredHowse
        </span>
      </div>
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}
