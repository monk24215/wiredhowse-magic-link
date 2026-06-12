import { Bebas_Neue, DM_Sans, JetBrains_Mono } from 'next/font/google';
import { headers } from 'next/headers';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

const bebasNeue = Bebas_Neue({
  weight: '400',
  subsets: ['latin'],
  variable: '--font-bebas-neue',
  display: 'swap',
});

const dmSans = DM_Sans({
  weight: ['400', '500'],
  subsets: ['latin'],
  variable: '--font-dm-sans',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  weight: ['400', '500'],
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'wiredHowse Auth',
    template: '%s · wiredHowse Auth',
  },
  description: 'Free hosted magic-link authentication for your site.',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // x-nonce is set by middleware and used for nonce-based CSP on inline scripts.
  const _nonce = (await headers()).get('x-nonce') ?? undefined;

  return (
    <html
      lang="en"
      className={`${bebasNeue.variable} ${dmSans.variable} ${jetbrainsMono.variable}`}
    >
      <body>
        {/* Fixed viewport background — logo perfectly centered, max 810px, stays in place on every page */}
        <div
          aria-hidden="true"
          style={{
            position: 'fixed',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 0,
            pointerEvents: 'none',
          }}
        >
          <img
            src="https://magic-link.wiredhowse.app/logo.png"
            alt=""
            style={{
              width: '810px',
              maxWidth: '810px',
              opacity: 0.07,
              userSelect: 'none',
            }}
          />
        </div>
        {/* All page content sits above the fixed background logo */}
        <div style={{ position: 'relative', zIndex: 1 }}>
          {children}
        </div>
      </body>
    </html>
  );
}
