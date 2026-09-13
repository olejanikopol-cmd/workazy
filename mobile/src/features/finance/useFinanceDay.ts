/**
 * Live local date for the Finance tab. Mirrors the proven plan/calendar lifecycle
 * pattern (focus refresh + AppState `active` + a bounded periodic recheck) and is
 * forms also sample the clock at submission to cover the interval between ticks.
 */
import { useCallback, useEffect, useState, useRef } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { createFinanceDayController } from './financeDay';
import { localDateIso } from './financeDates';

/** Bounded recheck (~30s) so midnight/timezone travel is picked up without events. */
export const FINANCE_DAY_RECHECK_MS = 30_000;

export function useFinanceToday(): { today: string; refresh: () => void } {
  const controller = useRef(createFinanceDayController({ now: () => new Date() }));
  const [today, setToday] = useState(() => localDateIso(new Date()));

  const refresh = useCallback(() => {
    const next = controller.current.sample().today;
    setToday((previous) => (previous === next ? previous : next));
  }, []);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') refresh();
    });
    const interval = setInterval(refresh, FINANCE_DAY_RECHECK_MS);
    return () => {
      subscription.remove();
      clearInterval(interval);
    };
  }, [refresh]);

  return { today, refresh };
}

/** Exported for wiring tests: the exact controller used by the tab. */
export function createFinanceTodayController(now: () => Date = () => new Date()) {
  return createFinanceDayController({ now });
}
