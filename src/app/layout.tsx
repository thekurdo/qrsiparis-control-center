import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'QrSiparis Control Center',
  description:
    'Cyxares internal panel for tenant onboarding, deployment orchestration, and infrastructure management',
  robots: { index: false, follow: false },
};

/**
 * Root layout — applies dark mode by default (V1 dark-only per IMPL §1).
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="tr" className="dark">
      <body className="bg-cc-bg text-slate-100 antialiased">{children}</body>
    </html>
  );
}
