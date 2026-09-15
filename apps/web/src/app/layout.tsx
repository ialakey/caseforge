import type { Metadata } from 'next';
import './globals.css';
import { Footer } from '../components/Footer';
import { Header } from '../components/Header';

export const metadata: Metadata = {
  title: 'CaseForge',
  description: 'CS2 case opening with provable fairness',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // The lang attribute starts at the default locale and is corrected on the
    // client once the stored preference is read.
    <html lang="ru">
      <body className="flex min-h-dvh flex-col">
        <Header />
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:py-8">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
