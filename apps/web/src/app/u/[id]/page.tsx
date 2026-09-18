import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { PublicProfileView } from '@caseforge/shared';
import { PublicProfile } from '../../../components/PublicProfile';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/**
 * Someone else's profile, as the drop feed links to it.
 *
 * Rendered on the server, and the API decides whether it exists at all: the
 * `publicProfiles` setting is enforced there, so switching profiles off closes
 * this page too without the front end having to know the rule. A 404 from the
 * API becomes a 404 here rather than an empty page.
 */
async function loadProfile(id: string): Promise<PublicProfileView | null> {
  try {
    const response = await fetch(`${API_URL}/api/users/${id}`, { cache: 'no-store' });
    if (!response.ok) return null;
    return (await response.json()) as PublicProfileView;
  } catch {
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const profile = await loadProfile(id);
  // `noindex`: these pages are thin, there is one per player, and none of them
  // is a page a search engine should be sending strangers to.
  return {
    title: profile?.username ?? 'Profile',
    robots: { index: false, follow: false },
  };
}

export default async function PublicProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = await loadProfile(id);
  if (!profile) notFound();

  return <PublicProfile profile={profile} />;
}
