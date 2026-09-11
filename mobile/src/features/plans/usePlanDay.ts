/**
 * Relative Today/Tomorrow selection for the daily plan with live refresh.
 *
 * The selected mode is remembered for the lifetime of the mounted workspace but
 * never persisted. Concrete dates recompute:
 *  - on screen focus and app foreground (`AppState` active),
 *  - on a bounded periodic recheck (every 60s) so device clock/timezone/midnight
 *    changes are picked up even without an event,
 *  - and the recheck is skipped when nothing changed (stable state).
 * Recomputing the relative dates never mutates stored tasks.
 */
import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { AppState } from 'react-native';
import { dateForMode, getPlanDates, type PlanDayMode } from './planDates';

const PLAN_DATE_RECHECK_MS = 60_000;

export type PlanDay = {
  mode: PlanDayMode;
  setMode: (mode: PlanDayMode) => void;
  /** Concrete local date for the selected mode. */
  date: string;
  today: string;
  tomorrow: string;
};

export function usePlanDay(): PlanDay {
  const [mode, setMode] = useState<PlanDayMode>('today');
  const [dates, setDates] = useState(() => getPlanDates(new Date()));

  // Stable: `setDates` returns the previous reference when nothing changed,
  // so periodic calls do not re-render.
  const refresh = useCallback(() => {
    const next = getPlanDates(new Date());
    setDates((prev) =>
      prev.today === next.today && prev.tomorrow === next.tomorrow ? prev : next,
    );
  }, []);

  // Refresh whenever the screen regains focus.
  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') refresh();
    });
    // Bounded periodic recheck: picks up device clock/timezone/midnight changes
    // even without events; the stable `refresh` makes no-ops cheap.
    const interval = setInterval(refresh, PLAN_DATE_RECHECK_MS);

    return () => {
      subscription.remove();
      clearInterval(interval);
    };
  }, [refresh]);

  return {
    mode,
    setMode,
    date: dateForMode(mode, dates.today, dates.tomorrow),
    today: dates.today,
    tomorrow: dates.tomorrow,
  };
}