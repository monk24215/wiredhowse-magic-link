import { headers } from 'next/headers';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'wiredHowse Auth',
    template: '%s · wiredHowse Auth',
  },
  description: 'Free hosted magic-link authentication for your site.',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Read the nonce injected by middleware. Next.js uses it to tag its internal
  // inline hydration scripts, enabling script-src 'nonce-…' CSP without unsafe-inline.
  const nonce = (await headers()).get('x-nonce') ?? undefined;

  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
