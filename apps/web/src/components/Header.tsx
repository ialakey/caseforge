'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { type FxRates, WS_EVENTS } from '@caseforge/shared';
import { api, loginUrl } from '../lib/api';
import { useAuth } from '../lib/store';
import { useSettings } from '../lib/settings';
import { getSocket } from '../lib/socket';
import { Money } from './Money';
import { SettingsSwitcher } from './SettingsSwitcher';
import { SteamAvatar } from './SteamAvatar';
import { DepositDialog } from './DepositDialog';

interface PublicConfig {
  depositsEnabled: boolean;
  fxRates: FxRates;
}

export function Header() {
  const { user, loading, loadUser, setBalance, logout } = useAuth();
  const { t, hydrate, setFxRates } = useSettings();
  const [depositsEnabled, setDepositsEnabled] = useState(false);
  const [depositOpen, setDepositOpen] = useState(false);

  useEffect(() => {
    // Stored language and currency are read after mount, never during server
    // rendering — see the note in lib/settings.
    hydrate();
    void loadUser();

    // Exchange rates and the top-up flag come from the server: the same build
    // has to work in an environment where the stub is off.
    void api<PublicConfig>('/api/config')
      .then((config) => {
        setDepositsEnabled(config.depositsEnabled);
        setFxRates(config.fxRates);
      })
      .catch(() => setDepositsEnabled(false));
  }, [hydrate, loadUser, setFxRates]);

  useEffect(() => {
    if (!user) return;
    // The balance arrives by push: opening a case in another tab or a manual
    // adjustment by an operator updates it on its own.
    const socket = getSocket();
    const onBalance = (payload: { balance: number }) => setBalance(payload.balance);
    socket.on(WS_EVENTS.BALANCE_UPDATED, onBalance);
    return () => {
      socket.off(WS_EVENTS.BALANCE_UPDATED, onBalance);
    };
  }, [user, setBalance]);

  const isStaff = user?.role === 'ADMIN' || user?.role === 'ANALYST' || user?.role === 'SUPPORT';

  return (
    <>
      <header className="border-b border-neutral-800 bg-neutral-900/60">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
          <Link href="/" className="text-lg font-semibold">
            Case<span className="text-amber-400">Forge</span>
          </Link>

          {/* The profile is gone from the left menu: it lives on the right, on the avatar. */}
          <nav className="flex gap-4 text-sm text-neutral-400">
            <Link href="/" className="hover:text-neutral-100">
              {t('nav.cases')}
            </Link>
            <Link href="/upgrade" className="hover:text-neutral-100">
              {t('nav.upgrade')}
            </Link>
            {isStaff && (
              <Link href="/admin" className="hover:text-neutral-100">
                {t('nav.crm')}
              </Link>
            )}
          </nav>

          <div className="ml-auto flex items-center gap-3 text-sm">
            <SettingsSwitcher />

            {loading ? null : user ? (
              <>
                <Money value={user.balance} className="font-medium text-amber-400" />

                {depositsEnabled && (
                  <button
                    onClick={() => setDepositOpen(true)}
                    className="rounded bg-emerald-600 px-3 py-1.5 font-medium text-white hover:bg-emerald-500"
                  >
                    {t('nav.topUp')}
                  </button>
                )}

                {/* The profile sits right here: Steam avatar and nickname. */}
                <Link
                  href="/profile"
                  className="flex items-center gap-2 rounded px-1 py-1 hover:bg-neutral-800"
                >
                  <SteamAvatar src={user.avatarUrl} name={user.username} size={28} />
                  <span className="max-w-[140px] truncate text-neutral-300">{user.username}</span>
                </Link>

                <button onClick={logout} className="text-neutral-500 hover:text-neutral-300">
                  {t('nav.signOut')}
                </button>
              </>
            ) : (
              <a
                href={loginUrl}
                className="flex items-center gap-2 rounded bg-blue-600 px-3 py-1.5 font-medium hover:bg-blue-500"
              >
                {t('nav.signIn')}
              </a>
            )}
          </div>
        </div>
      </header>

      {depositOpen && <DepositDialog onClose={() => setDepositOpen(false)} />}
    </>
  );
}
