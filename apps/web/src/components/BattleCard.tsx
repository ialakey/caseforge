'use client';

import Link from 'next/link';
import { type BattleSummary, localizedName } from '@caseforge/shared';
import { useSettings } from '../lib/settings';
import { Money } from './Money';
import { SteamAvatar } from './SteamAvatar';

/**
 * One battle in the lobby.
 *
 * It has to answer three questions at a glance: what is being opened, who is
 * already in, and what a seat costs. Everything else — the rolls, the reels —
 * belongs on the battle's own page.
 */
export function BattleCard({
  battle,
  userId,
  busy,
  onJoin,
  onCancel,
}: {
  battle: BattleSummary;
  userId: string | null;
  busy: boolean;
  onJoin: (id: string) => void;
  onCancel: (id: string) => void;
}) {
  const { locale, t } = useSettings();

  const seated = battle.players.some((player) => player.userId === userId);
  const host = battle.players.find((player) => player.slot === 1);
  const isHost = host?.userId === userId && userId !== null;
  const open = battle.status === 'WAITING';
  const canJoin = open && userId !== null && !seated && battle.filledSlots < battle.slots;
  const winner = battle.players.find((player) => player.isWinner);

  return (
    <div className="cf-panel flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span
          data-crazy={battle.mode === 'CRAZY'}
          className="rounded-full border border-edge-subtle px-2 py-0.5 text-ink-muted data-[crazy=true]:border-negative/50 data-[crazy=true]:text-negative"
        >
          {t(`battles.mode${battle.mode}`)}
        </span>
        <span className="text-ink-faint">
          {t('battles.rounds')}: {battle.rounds}
        </span>
        <span className="ml-auto text-ink-faint">{t(`battles.status${battle.status}`)}</span>
      </div>

      {/* The case list, with a multiplier where a case is worth several rounds. */}
      <div className="flex flex-wrap items-center gap-2">
        {battle.cases.map((line) => (
          <div
            key={line.caseId}
            title={localizedName(locale, line)}
            className="flex items-center gap-1 rounded bg-surface-overlay px-2 py-1"
          >
            {line.imageUrl ? (
              <img src={line.imageUrl} alt="" className="h-7 w-9 object-contain" />
            ) : (
              <span className="text-lg" aria-hidden>
                📦
              </span>
            )}
            {line.count > 1 && <span className="text-[11px] text-ink-muted">×{line.count}</span>}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        {Array.from({ length: battle.slots }, (_, index) => {
          const player = battle.players.find((p) => p.slot === index + 1);
          return player ? (
            <div
              key={index}
              title={player.username}
              data-winner={player.isWinner}
              className="flex items-center gap-1.5 rounded-full bg-surface-overlay py-0.5 pl-0.5 pr-2 data-[winner=true]:bg-accent/15"
            >
              <SteamAvatar src={player.avatarUrl} name={player.username} size={22} />
              <span className="max-w-[90px] truncate text-xs text-ink-muted">
                {player.userId === userId ? t('battles.you') : player.username}
              </span>
            </div>
          ) : (
            <span
              key={index}
              className="rounded-full border border-dashed border-edge-strong px-2.5 py-1 text-[11px] text-ink-faint"
            >
              {t('battles.slotFree')}
            </span>
          );
        })}
      </div>

      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-edge-subtle pt-3">
        <div className="text-sm">
          <span className="text-ink-faint">
            {battle.status === 'FINISHED' ? t('battles.pot') : t('battles.entry')}{' '}
          </span>
          <Money
            value={battle.status === 'FINISHED' ? (battle.totalValue ?? 0) : battle.entryPrice}
            className="font-semibold text-accent"
          />
        </div>

        <div className="flex items-center gap-2">
          {winner && (
            <span className="text-xs text-ink-muted">
              {t('battles.winner', {
                username: winner.userId === userId ? t('battles.you') : winner.username,
              })}
            </span>
          )}
          {isHost && open && (
            <button
              onClick={() => onCancel(battle.id)}
              disabled={busy}
              className="cf-btn-ghost px-3 py-1.5 text-sm"
            >
              {t('battles.cancel')}
            </button>
          )}
          {canJoin ? (
            <button
              onClick={() => onJoin(battle.id)}
              disabled={busy}
              className="cf-btn-primary px-4 py-1.5 text-sm"
            >
              {busy ? t('battles.joining') : t('battles.join')}
            </button>
          ) : (
            <Link href={`/battles/${battle.id}`} className="cf-btn-ghost px-4 py-1.5 text-sm">
              {t('battles.watch')}
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
