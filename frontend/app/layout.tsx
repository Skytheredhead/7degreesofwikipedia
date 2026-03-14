import type { Metadata } from 'next';
import { Syne, Azeret_Mono } from 'next/font/google';

import './globals.css';

const syne = Syne({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-syne',
  display: 'swap',
});

const azeretMono = Azeret_Mono({
  subsets: ['latin'],
  weight: ['300', '400', '500'],
  variable: '--font-azeret',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Seven Degrees of Wikipedia',
  description: 'Find the shortest path between any two Wikipedia articles',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${syne.variable} ${azeretMono.variable}`}>
      <body className="font-display antialiased">{children}</body>
    </html>
  );
}
