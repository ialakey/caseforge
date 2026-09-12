import type { Metadata } from 'next';
import './globals.css';
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
      <body>
        <Header />
        <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
