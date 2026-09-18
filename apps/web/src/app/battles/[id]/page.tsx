'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  type BattleActionResult,
  type BattleDropView,
  type BattleSummary,
  type BattleView,
  WS_EVENTS,
  localizedName,
  translateError,
} from '@caseforge/shared';
import { api, ApiError, loginUrl } from '../../../lib/api';
import { useAuth } from '../../../lib/store';
import { useSettings } from '../../../lib/settings';
import { getSocket } from '../../../lib/socket';
import { ItemImage } from '../../../components/ItemImage';
import { Money, useMoneyFormatter } from '../../../components/Money';
import { Roulette } from '../../../components/Roulette';
import { SteamAvatar } from '../../../components/SteamAvatar';
import { rarityColor } from '../../../components/RarityBadge';

/** How long the eye gets to read a round before the next one starts. */
const ROUND_PAUSE_MS = 700;

/** A battle still waiting for seats is re-read on a timer in case the socket is gone. */
const POLL_MS = 6_000;

export default function BattlePage() {
  const params = useParams<{ id: string }>();
  const battleId = params.id;

  const { user, setBalance } = useAuth();
  const { locale, t } = useSettings();
  const money = useMoneyFormatter();

  const [battle, setBattle] = useState<BattleView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Playback state.
   *
   * `activeRound` is the round currently spinning, `playedRound` the last one
   * whose reels have stopped. A battle that was already over when the page
   * opened is not replayed — thirty rounds of animation to watch somebody
   * else's finished game is not a feature — so both stay at the end and the
   * drops are simply listed.
   */
  const [activeRound, setActiveRound] = useState(0);
  const [playedRound, setPlayedRound] = useState(0);
  const finishedReels = useRef(0);
  const wasUnfinished = useRef(false);
  const roundTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = useCallback(async (): Promise<BattleView | null> => {
    try {
      const next = await api<BattleView>(`/api/battles/${battleId}`);
      setBattle(next);
      return next;
    } catch (err) {
      setError(
        err instanceof ApiError
          ? translateError(locale, err.code, err.message)
          : t('battles.notFound'),
      );
      return null;
    }
  }, [battleId, locale, t]);

  useEffect(() => {
    void load().then((next) => {
      if (!next) return;
      if (next.status === 'WAITING' || next.status === 'RUNNING') {
        wasUnfinished.current = true;
      } else {
        // Opened after the fact: everything is already revealed.
        setPlayedRound(next.rounds);
      }
    });
  }, [load]);

  // The battle fills, is played or is called off elsewhere; the page follows.
  useEffect(() => {
    const socket = getSocket();
    const onBattle = (summary: BattleSummary) => {
      if (summary.id !== battleId) return;
      void load().then((next) => {
        if (next?.status === 'FINISHED' && wasUnfinished.current) {
          wasUnfinished.current = false;
          finishedReels.current = 0;
          setActiveRound(1);
        }
      });
    };
    socket.on(WS_EVENTS.BATTLE_UPDATED, onBattle);
    return () => {
      socket.off(WS_EVENTS.BATTLE_UPDATED, onBattle);
    };
  }, [battleId, load]);

  // A dropped socket must not leave somebody staring at a lobby that filled
  // minutes ago, so a waiting battle is also re-read on a timer.
  useEffect(() => {
    if (battle?.status !== 'WAITING') return;
    const timer = setInterval(() => {
      void load().then((next) => {
        if (next?.status === 'FINISHED' && wasUnfinished.current) {
          wasUnfinished.current = false;
          finishedReels.current = 0;
          setActiveRound(1);
        }
      });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [battle?.status, load]);

  const dropsByRoundAndSlot = useMemo(() => {
    const map = new Map<string, BattleDropView>();
    for (const drop of battle?.drops ?? []) map.set(`${drop.round}:${drop.slot}`, drop);
    return map;
  }, [battle]);

  const caseById = useMemo(
    () => new Map((battle?.cases ?? []).map((line) => [line.case.id, line.case])),
    [battle],
  );

  /** Called by every reel in the round; the round advances on the last one. */
  const handleReelFinish = useCallback(() => {
    finishedReels.current += 1;
    const seats = battle?.players.length ?? 0;
    if (finishedReels.current < seats) return;

    finishedReels.current = 0;
    setPlayedRound(activeRound);
    roundTimer.current = setTimeout(() => {
      setActiveRound((current) => (current < (battle?.rounds ?? 0) ? current + 1 : 0));
    }, ROUND_PAUSE_MS);
  }, [activeRound, battle]);

  // Leaving mid-playback must not leave a timer trying to start a round on a
  // page that is gone.
  useEffect(() => () => clearTimeout(roundTimer.current), []);

  async function join(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<BattleActionResult>(`/api/battles/${battleId}/join`, {
        method: 'POST',
      });
      setBalance(result.balanceAfter);
      // Joining may have been the seat that filled it, in which case the reply
      // already carries the played battle.
      setBattle(result.battle);
      if (result.battle.status === 'FINISHED') {
        wasUnfinished.current = false;
        finishedReels.current = 0;
        setActiveRound(1);
      }
    } catch (err) {
      setError(
        err instanceof ApiError
          ? translateError(locale, err.code, err.message)
          : t('battles.joinFailed'),
      );
      void load();
    } finally {
      setBusy(false);
    }
  }

  async function cancel(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await api(`/api/battles/${battleId}/cancel`, { method: 'POST' });
      await load();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? translateError(locale, err.code, err.message)
          : t('battles.cancelFailed'),
      );
    } finally {
      setBusy(false);
    }
  }

  if (!battle) {
    return (
      <div className="space-y-3 text-center">
        <p className="text-ink-muted">{error ?? t('common.loading')}</p>
        <Link href="/battles" className="cf-btn-ghost inline-block px-4 py-2">
          {t('battles.title')}
        </Link>
      </div>
    );
  }

  const seated = battle.players.some((player) => player.userId === user?.id);
  const isHost = battle.players.find((p) => p.slot === 1)?.userId === user?.id;
  const canJoin =
    battle.status === 'WAITING' && user !== null && !seated && battle.filledSlots < battle.slots;
  const winner = battle.players.find((player) => player.isWinner);
  /**
   * A tie is the one outcome the result line cannot explain by itself: two
   * equal totals with one winner reads as a bug unless the deciding drop is
   * named. It is recomputed here from the drops on the page rather than sent
   * by the server, because the rule is a function of them.
   */
  const tied =
    winner !== undefined &&
    battle.players.filter((player) => player.totalValue === winner.totalValue).length > 1;
  const decidingDrop = tied
    ? battle.drops
        .filter((drop) => drop.slot === winner.slot)
        .reduce(
          (best, drop) =>
            battle.mode === 'CRAZY'
              ? Math.min(best, drop.item.price)
              : Math.max(best, drop.item.price),
          battle.mode === 'CRAZY' ? Number.MAX_SAFE_INTEGER : 0,
        )
    : 0;
  const activeCase =
    activeRound > 0 ? caseById.get(battle.order[activeRound - 1] ?? '') : undefined;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/battles" className="text-sm text-ink-faint hover:text-ink-primary">
          ← {t('battles.title')}
        </Link>
        <span className="rounded-full border border-edge-subtle px-2 py-0.5 text-xs text-ink-muted">
          {t(`battles.mode${battle.mode}`)}
        </span>
        <span className="text-xs text-ink-faint">{t(`battles.status${battle.status}`)}</span>
        <div className="ml-auto flex items-center gap-4 text-sm">
          <span>
            <span className="text-ink-faint">{t('battles.entry')} </span>
            <Money value={battle.entryPrice} className="font-medium text-accent" />
          </span>
          <span>
            <span className="text-ink-faint">{t('battles.pot')} </span>
            <Money
              value={battle.totalValue ?? battle.entryPrice * battle.slots}
              className="font-medium text-accent"
            />
          </span>
        </div>
      </div>

      {error && <p className="rounded bg-negative/15 px-3 py-2 text-sm text-negative">{error}</p>}

      {/* The case list, in the order the rounds are played. */}
      <div className="flex flex-wrap items-center gap-2">
        {battle.cases.map((line) => (
          <div
            key={line.case.id}
            className="flex items-center gap-1.5 rounded bg-surface-overlay px-2 py-1"
            title={localizedName(locale, line.case)}
          >
            {line.case.imageUrl && (
              <img src={line.case.imageUrl} alt="" className="h-7 w-9 object-contain" />
            )}
            <span className="text-xs text-ink-muted">{localizedName(locale, line.case)}</span>
            {line.count > 1 && <span className="text-[11px] text-accent">×{line.count}</span>}
          </div>
        ))}
        {activeRound > 0 && activeCase && (
          <span className="ml-auto text-xs text-ink-muted">
            {t('battles.round', { round: activeRound, total: battle.rounds })} ·{' '}
            {localizedName(locale, activeCase)}
          </span>
        )}
      </div>

      {battle.status === 'CANCELLED' && (
        <p className="rounded bg-surface-overlay px-3 py-2 text-sm text-ink-muted">
          {t('battles.cancelledNotice')}
        </p>
      )}

      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: `repeat(${battle.slots}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: battle.slots }, (_, index) => {
          const slot = index + 1;
          const player = battle.players.find((p) => p.slot === slot);
          const revealed = battle.drops.filter(
            (drop) => drop.slot === slot && drop.round <= playedRound,
          );
          const total = revealed.reduce((sum, drop) => sum + drop.item.price, 0);
          const spinning = activeRound > 0 && activeCase !== undefined && player !== undefined;
          const roundDrop = dropsByRoundAndSlot.get(`${activeRound}:${slot}`);

          return (
            <div
              key={slot}
              data-winner={player?.isWinner === true && activeRound === 0}
              className="cf-panel flex flex-col gap-2 p-3 data-[winner=true]:border-accent/60"
            >
              <div className="flex items-center gap-2">
                {player ? (
                  <>
                    <SteamAvatar src={player.avatarUrl} name={player.username} size={26} />
                    <span className="truncate text-sm">
                      {player.userId === user?.id ? t('battles.you') : player.username}
                    </span>
                  </>
                ) : (
                  <span className="text-sm text-ink-faint">{t('battles.slotFree')}</span>
                )}
                <Money value={total} className="ml-auto text-sm font-medium text-accent" />
              </div>

              {spinning && activeCase && roundDrop ? (
                <Roulette
                  pool={activeCase.items}
                  winner={roundDrop.item}
                  spinId={activeRound}
                  orientation="vertical"
                  index={index}
                  onFinish={handleReelFinish}
                />
              ) : (
                <div className="grid grid-cols-3 gap-1">
                  {revealed.map((drop) => (
                    <div
                      key={drop.openingId}
                      title={`${drop.item.marketHashName} · ${money(drop.item.price)} · roll ${drop.roll}`}
                      className="rounded bg-surface-base p-1"
                      style={{ borderBottom: `2px solid ${rarityColor(drop.item.rarity)}` }}
                    >
                      <ItemImage
                        src={drop.item.imageUrl}
                        alt={drop.item.marketHashName}
                        rarity={drop.item.rarity}
                        className="h-10 w-full"
                      />
                    </div>
                  ))}
                  {revealed.length === 0 && (
                    <p className="col-span-3 py-8 text-center text-xs text-ink-faint">
                      {battle.status === 'WAITING' ? t('battles.waitingRoom') : '—'}
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex flex-col items-center gap-2">
        {canJoin && (
          <button
            onClick={() => void join()}
            disabled={busy}
            className="cf-btn-primary px-8 py-2.5"
          >
            {busy ? t('battles.joining') : `${t('battles.join')} · ${money(battle.entryPrice)}`}
          </button>
        )}
        {!user && battle.status === 'WAITING' && (
          <a href={loginUrl} className="cf-btn-primary px-8 py-2.5">
            {t('nav.signIn')}
          </a>
        )}
        {isHost && battle.status === 'WAITING' && (
          <button onClick={() => void cancel()} disabled={busy} className="cf-btn-ghost px-6 py-2">
            {t('battles.cancel')}
          </button>
        )}

        {winner && activeRound === 0 && (
          <p className="text-center text-sm">
            {winner.userId === user?.id ? (
              <span className="font-medium text-positive">
                {t('battles.youWon', { amount: money(battle.totalValue ?? 0) })}
              </span>
            ) : (
              <span className="text-ink-muted">
                {t('battles.youLost', {
                  username: winner.username,
                  amount: money(battle.totalValue ?? 0),
                })}
              </span>
            )}
            {tied && (
              <span className="ml-2 text-ink-faint">
                {t('battles.tiebreak', { amount: money(decidingDrop) })}
              </span>
            )}
          </p>
        )}

        <p className="max-w-3xl text-center text-xs text-ink-faint">{t('battles.fairnessHint')}</p>
      </div>
    </div>
  );
}
