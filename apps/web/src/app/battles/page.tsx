'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  type BattleActionResult,
  type BattleSummary,
  type CaseView,
  BATTLE_MAX_CASE_LINES,
  BATTLE_MAX_ROUNDS,
  BATTLE_MODES,
  BATTLE_PLAYER_PRESETS,
  type BattleMode,
  WS_EVENTS,
  localizedName,
  translateError,
} from '@caseforge/shared';
import { api, ApiError, loginUrl } from '../../lib/api';
import { useAuth } from '../../lib/store';
import { useSettings } from '../../lib/settings';
import { getSocket } from '../../lib/socket';
import { BattleCard } from '../../components/BattleCard';
import { Money, useMoneyFormatter } from '../../components/Money';

interface Lobby {
  open: BattleSummary[];
  finished: BattleSummary[];
}

/** A line of the battle being assembled: a case and how many rounds of it. */
interface PickedLine {
  caseId: string;
  count: number;
}

export default function BattlesPage() {
  const router = useRouter();
  const { user, setBalance } = useAuth();
  const { locale, t } = useSettings();
  const money = useMoneyFormatter();

  const [lobby, setLobby] = useState<Lobby>({ open: [], finished: [] });
  const [cases, setCases] = useState<CaseView[]>([]);
  const [picked, setPicked] = useState<PickedLine[]>([]);
  const [mode, setMode] = useState<BattleMode>('STANDARD');
  const [slots, setSlots] = useState<number>(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [next, catalogue] = await Promise.all([
        api<Lobby>('/api/battles'),
        api<CaseView[]>('/api/cases'),
      ]);
      setLobby(next);
      setCases(catalogue);
    } catch {
      setError(t('battles.loadFailed'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * The lobby is a shared room: a seat taken in another browser has to
   * disappear here without a reload, and a battle that has just been played
   * has to move across to the history by itself.
   */
  useEffect(() => {
    const socket = getSocket();
    const onBattle = (battle: BattleSummary) => {
      setLobby((current) => ({
        open:
          battle.status === 'WAITING' || battle.status === 'RUNNING'
            ? [battle, ...current.open.filter((b) => b.id !== battle.id)]
            : current.open.filter((b) => b.id !== battle.id),
        finished:
          battle.status === 'FINISHED'
            ? [battle, ...current.finished.filter((b) => b.id !== battle.id)].slice(0, 12)
            : current.finished,
      }));
    };
    socket.on(WS_EVENTS.BATTLE_UPDATED, onBattle);
    return () => {
      socket.off(WS_EVENTS.BATTLE_UPDATED, onBattle);
    };
  }, []);

  const priceById = useMemo(
    () => new Map(cases.map((gameCase) => [gameCase.id, gameCase.price])),
    [cases],
  );
  const rounds = picked.reduce((sum, line) => sum + line.count, 0);
  const entryPrice = picked.reduce(
    (sum, line) => sum + (priceById.get(line.caseId) ?? 0) * line.count,
    0,
  );

  function addRound(caseId: string): void {
    setPicked((current) => {
      if (rounds >= BATTLE_MAX_ROUNDS) return current;
      const line = current.find((l) => l.caseId === caseId);
      if (line) {
        return current.map((l) => (l.caseId === caseId ? { ...l, count: l.count + 1 } : l));
      }
      if (current.length >= BATTLE_MAX_CASE_LINES) return current;
      return [...current, { caseId, count: 1 }];
    });
  }

  function removeRound(caseId: string): void {
    setPicked((current) =>
      current
        .map((line) => (line.caseId === caseId ? { ...line, count: line.count - 1 } : line))
        .filter((line) => line.count > 0),
    );
  }

  async function create(): Promise<void> {
    if (picked.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<BattleActionResult>('/api/battles', {
        method: 'POST',
        body: JSON.stringify({ mode, slots, cases: picked }),
      });
      setBalance(result.balanceAfter);
      router.push(`/battles/${result.battle.id}`);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? translateError(locale, err.code, err.message)
          : t('battles.createFailed'),
      );
      setBusy(false);
    }
  }

  async function join(battleId: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<BattleActionResult>(`/api/battles/${battleId}/join`, {
        method: 'POST',
      });
      setBalance(result.balanceAfter);
      router.push(`/battles/${battleId}`);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? translateError(locale, err.code, err.message)
          : t('battles.joinFailed'),
      );
      setBusy(false);
      void load();
    }
  }

  async function cancel(battleId: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
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

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">{t('battles.title')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-faint">{t('battles.intro')}</p>
      </div>

      {error && <p className="rounded bg-negative/15 px-3 py-2 text-sm text-negative">{error}</p>}

      <section className="cf-panel space-y-4 p-5">
        <div className="flex flex-wrap items-center gap-4">
          <h2 className="font-medium">{t('battles.create')}</h2>

          <div className="flex items-center gap-1.5">
            {BATTLE_MODES.map((option) => (
              <button
                key={option}
                onClick={() => setMode(option)}
                data-active={mode === option}
                title={t(`battles.modeHint${option}`)}
                className="cf-chip px-3 py-1.5"
              >
                {t(`battles.mode${option}`)}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-xs text-ink-faint">{t('battles.slots')}</span>
            {BATTLE_PLAYER_PRESETS.map((preset) => (
              <button
                key={preset}
                onClick={() => setSlots(preset)}
                data-active={slots === preset}
                className="cf-chip w-9 py-1.5"
              >
                {preset}
              </button>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="text-ink-faint">
              {t('battles.rounds')} {rounds}/{BATTLE_MAX_ROUNDS}
            </span>
            <span className="text-ink-faint">{t('battles.entry')}</span>
            <Money value={entryPrice} className="font-semibold text-accent" />
            {picked.length > 0 && (
              <button onClick={() => setPicked([])} className="text-ink-faint hover:text-ink-muted">
                {t('battles.clear')}
              </button>
            )}
          </div>
        </div>

        <p className="text-xs text-ink-faint">
          {t('battles.pickCasesHint', { rounds: BATTLE_MAX_ROUNDS })}
        </p>

        <div className="grid max-h-[340px] grid-cols-2 gap-2 overflow-y-auto pr-1 sm:grid-cols-4 lg:grid-cols-6">
          {cases.map((gameCase) => {
            const line = picked.find((l) => l.caseId === gameCase.id);
            return (
              <button
                key={gameCase.id}
                onClick={() => addRound(gameCase.id)}
                // The second button takes a round back off, so a mis-click on a
                // 25-case list does not mean starting the whole list again.
                onContextMenu={(event) => {
                  event.preventDefault();
                  removeRound(gameCase.id);
                }}
                className={`rounded border-t-2 border-t-transparent bg-surface-base p-2 text-left transition hover:bg-surface-overlay ${
                  line ? 'ring-2 ring-accent' : ''
                }`}
              >
                <div className="relative">
                  {gameCase.imageUrl ? (
                    <img
                      src={gameCase.imageUrl}
                      alt={localizedName(locale, gameCase)}
                      className="mb-1 h-14 w-full object-contain"
                    />
                  ) : (
                    <div
                      className="mb-1 flex h-14 items-center justify-center text-2xl"
                      aria-hidden
                    >
                      📦
                    </div>
                  )}
                  {line && (
                    <span className="absolute right-0 top-0 rounded bg-accent px-1.5 text-[11px] font-bold text-surface-base">
                      ×{line.count}
                    </span>
                  )}
                </div>
                <div className="truncate text-[11px]">{localizedName(locale, gameCase)}</div>
                <Money value={gameCase.price} className="text-[11px] text-accent" />
              </button>
            );
          })}
        </div>

        <div className="flex flex-col items-center gap-2">
          {user ? (
            <button
              onClick={() => void create()}
              disabled={picked.length === 0 || busy}
              className="cf-btn-primary px-8 py-2.5"
            >
              {busy
                ? t('battles.creating')
                : `${t('battles.create')} · ${money(entryPrice * slots)}`}
            </button>
          ) : (
            <a href={loginUrl} className="cf-btn-primary px-8 py-2.5">
              {t('nav.signIn')}
            </a>
          )}
          {picked.length === 0 && (
            <p className="text-xs text-ink-faint">{t('battles.selectionEmpty')}</p>
          )}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-ink-faint">
          {t('battles.lobby')}
        </h2>
        {lobby.open.length === 0 ? (
          <p className="text-sm text-ink-faint">{t('battles.lobbyEmpty')}</p>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {lobby.open.map((battle) => (
              <BattleCard
                key={battle.id}
                battle={battle}
                userId={user?.id ?? null}
                busy={busy}
                onJoin={(id) => void join(id)}
                onCancel={(id) => void cancel(id)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-ink-faint">
          {t('battles.history')}
        </h2>
        {lobby.finished.length === 0 ? (
          <p className="text-sm text-ink-faint">{t('battles.historyEmpty')}</p>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {lobby.finished.map((battle) => (
              <BattleCard
                key={battle.id}
                battle={battle}
                userId={user?.id ?? null}
                busy={busy}
                onJoin={(id) => void join(id)}
                onCancel={(id) => void cancel(id)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
