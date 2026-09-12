import type { CaseView } from '@caseforge/shared';
import { notFound } from 'next/navigation';
import { CaseOpener } from '../../../components/CaseOpener';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

async function loadCase(slug: string): Promise<CaseView | null> {
  const response = await fetch(`${API_URL}/api/cases/${slug}`, { cache: 'no-store' });
  if (!response.ok) return null;
  return response.json() as Promise<CaseView>;
}

export default async function CasePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const gameCase = await loadCase(slug);
  if (!gameCase) notFound();

  return <CaseOpener gameCase={gameCase} />;
}
