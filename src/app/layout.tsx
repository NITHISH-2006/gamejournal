import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import Navbar from '@/components/Navbar';
import Ambient from '@/components/Ambient';
import { ToastProvider } from '@/components/Toast';
import { getSiteUrl } from '@/lib/env';

const geistSans = Geist({
  subsets: ['latin'],
  variable: '--font-geist-sans',
  display: 'swap',
});

const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
  display: 'swap',
});

const siteUrl = getSiteUrl();

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: 'GameJournal - Track every game you play',
    template: '%s | GameJournal',
  },
  description:
    'GameJournal is a social journal for video games. Log what you play, rate it, review it, and discover what your friends are playing.',
  keywords: [
    'games',
    'gaming journal',
    'game tracker',
    'game reviews',
    'backlog',
    'Letterboxd for games',
  ],
  authors: [{ name: 'Nithish C.' }],
  creator: 'Nithish C.',
  applicationName: 'GameJournal',
  openGraph: {
    type: 'website',
    siteName: 'GameJournal',
    title: 'GameJournal - Track every game you play',
    description:
      'Log games, rate them, write reviews, and see what your friends are playing.',
    url: siteUrl,
  },
  twitter: {
    card: 'summary_large_image',
    title: 'GameJournal - Track every game you play',
    description:
      'Log games, rate them, write reviews, and see what your friends are playing.',
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, 'max-image-preview': 'large' },
  },
  // NO root-level `alternates.canonical`.
  //
  // Next merges metadata field-by-field down the tree, so a canonical declared
  // here is inherited by every route that does not declare its own. `/profile`
  // declares only `robots: { index: false }`, so it was emitting
  // `<link rel="canonical" href="https://site/">` — telling search engines the
  // private dashboard lives at the site root. Each page sets its own canonical
  // where one is meaningful, and `metadataBase` above resolves relative ones.
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: '#0c0c12',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`dark ${geistSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-dvh antialiased">
        <ToastProvider>
          <Ambient />
          <a
            href="#main"
            className="sr-only rounded-lg focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[200] focus:bg-brand focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white"
          >
            Skip to content
          </a>
          <Navbar />
          <main id="main" className="pt-20 pb-24">
            {children}
          </main>
          {/* `pb-24` on <main> clears the mobile tab bar, but the footer sits
              *after* it and only had `py-8`, so the last line was permanently
              hidden underneath the fixed `MobileNav` on phones. The clearance
              belongs on the last element in the document flow. */}
          <footer className="border-t border-white/6 px-6 pt-8 pb-24 md:pb-8">
            <div className="mx-auto flex max-w-5xl flex-col items-center gap-2 text-center">
              <p className="text-sm font-semibold">
                <span className="text-gradient">GameJournal</span>
              </p>
              <p className="text-xs text-muted-foreground">
                Track your backlog. Share the story.
              </p>
            </div>
          </footer>
        </ToastProvider>
      </body>
    </html>
  );
}
