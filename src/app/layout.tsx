import type { Metadata } from 'next';
import { Geist } from 'next/font/google';
import './globals.css';
import Navbar from '@/components/Navbar';
import { ToastProvider } from '@/components/Toast';

const geist = Geist({ subsets: ['latin'], variable: '--font-geist' });

export const metadata: Metadata = {
  title: 'GameJournal — Letterboxd for Video Games',
  description: 'Track, rate, and review every game you play.',
  openGraph: {
    title: 'GameJournal',
    description: 'Letterboxd for Video Games — log, rate, and discover games.',
    type: 'website',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={geist.variable}>
      <body className="bg-zinc-950 text-white antialiased min-h-screen flex flex-col">
        <ToastProvider>
          <Navbar />
          <main className="flex-1 pt-16">{children}</main>
        </ToastProvider>
      </body>
    </html>
  );
}
