'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
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
      {/* Sticky and translucent: the reel and the catalogue scroll under it,
          and the balance has to stay reachable while they do. */}
      <header className="sticky top-0 z-40 border-b border-edge-subtle bg-surface-base/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center gap-5 px-4 py-3">
          <Link href="/" className="text-lg font-bold tracking-tight">
            Case<span className="text-accent">Forge</span>
          </Link>

          {/* The profile is gone from the left menu: it lives on the right, on the avatar. */}
          <nav className="flex gap-1 text-sm">
            <NavLink href="/">{t('nav.cases')}</NavLink>
            <NavLink href="/battles">{t('nav.battles')}</NavLink>
            <NavLink href="/upgrade">{t('nav.upgrade')}</NavLink>
            <NavLink href="/contract">{t('nav.contract')}</NavLink>
            <NavLink href="/bonus">{t('nav.bonus')}</NavLink>
            {/* The referral page is only useful with a code on it, and a code
                only exists for somebody signed in. */}
            {user && <NavLink href="/referral">{t('nav.referral')}</NavLink>}
            {isStaff && <NavLink href="/admin">{t('nav.crm')}</NavLink>}
          </nav>

          <div className="ml-auto flex items-center gap-3 text-sm">
            <SettingsSwitcher />

            {loading ? null : user ? (
              <>
                {/* Balance and top-up read as one control: the plus is what the
                    player reaches for the moment the number is too small. */}
                <div className="flex items-center overflow-hidden rounded-full border border-edge-subtle bg-surface-overlay">
                  <Money value={user.balance} className="px-3 py-1.5 font-semibold text-accent" />
                  {depositsEnabled && (
                    <button
                      onClick={() => setDepositOpen(true)}
                      aria-label={t('nav.topUp')}
                      title={t('nav.topUp')}
                      className="h-full border-l border-edge-subtle bg-positive/15 px-3 py-1.5 font-semibold text-positive transition hover:bg-positive/25"
                    >
                      +
                    </button>
                  )}
                </div>

                {/* The profile sits right here: Steam avatar and nickname. */}
                <Link
                  href="/profile"
                  className="flex items-center gap-2 rounded-full py-1 pl-1 pr-3 transition hover:bg-surface-overlay"
                >
                  <SteamAvatar src={user.avatarUrl} name={user.username} size={28} />
                  <span className="hidden max-w-[140px] truncate text-ink-muted sm:block">
                    {user.username}
                  </span>
                </Link>

                <button
                  onClick={logout}
                  className="text-ink-faint transition hover:text-ink-primary"
                >
                  {t('nav.signOut')}
                </button>
              </>
            ) : (
              <a href={loginUrl} className="cf-btn-primary px-4 py-2">
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

/** A nav entry that shows where the player currently is. */
function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const active = href === '/' ? pathname === '/' : pathname.startsWith(href);

  return (
    <Link
      href={href}
      data-active={active}
      className="rounded-lg px-3 py-1.5 text-ink-muted transition hover:bg-surface-overlay hover:text-ink-primary data-[active=true]:bg-surface-overlay data-[active=true]:text-ink-primary"
    >
      {children}
    </Link>
  );
}
