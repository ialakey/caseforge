'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { setToken } from '../../../lib/api';
import { useAuth } from '../../../lib/store';
import { useT } from '../../../lib/settings';

export default function AuthCallbackPage() {
  const router = useRouter();
  const loadUser = useAuth((s) => s.loadUser);
  const t = useT();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // The token arrives in the URL fragment: a fragment is never sent to the
    // server, stays out of proxy logs and out of the Referer header.
    const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
    if (!token) {
      setError(t('auth.noToken'));
      return;
    }

    setToken(token);
    history.replaceState(null, '', '/auth/callback');
    void loadUser().then(() => router.replace('/'));
  }, [loadUser, router]);

  return (
    <p className="text-neutral-400">{error ?? t('auth.finishing')}</p>
  );
}
