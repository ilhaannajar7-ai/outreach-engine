import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from '@/components/Providers';
import { Assistant } from '@/components/Assistant';

export const metadata: Metadata = {
  title: 'Outreach Command Center',
  description: 'AI-powered outreach engine',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          {children}
          {/* Global so it is reachable from every page; hides itself when
              nobody is signed in. */}
          <Assistant />
        </Providers>
      </body>
    </html>
  );
}
