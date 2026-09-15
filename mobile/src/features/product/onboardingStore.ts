export const ONBOARDING_KEY = 'workazy-native-onboarding-v1';
export type OnboardingState = Readonly<{ phase: 'loading' | 'ready' | 'load-error'; completed: boolean; dismissed: boolean; replay: boolean; saving: boolean; error: string | null }>;
export function createOnboardingStore(storage: { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> }) {
  let state: OnboardingState = Object.freeze({ phase: 'loading', completed: false, dismissed: false, replay: false, saving: false, error: null });
  const listeners = new Set<() => void>();
  let loading: Promise<void> | null = null;
  const publish = (patch: Partial<OnboardingState>) => { state = Object.freeze({ ...state, ...patch }); for (const fn of listeners) fn(); };
  function load(): Promise<void> {
    if (loading) return loading;
    if (state.phase === 'ready') return Promise.resolve();
    publish({ phase: 'loading', error: null });
    loading = Promise.resolve().then(async () => {
      try {
        const raw = await storage.getItem(ONBOARDING_KEY);
        let completed = false;
        if (raw !== null) {
          const parsed: unknown = JSON.parse(raw);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
            Object.keys(parsed).sort().join(',') !== 'completed,version' ||
            (parsed as { version?: unknown }).version !== 1 || typeof (parsed as { completed?: unknown }).completed !== 'boolean') throw Error('invalid');
          completed = (parsed as { completed: boolean }).completed;
        }
        publish({ phase: 'ready', completed });
      } catch { publish({ phase: 'load-error', error: 'Не удалось открыть настройки знакомства. Ваши записи не изменены.' }); }
    }).finally(() => { loading = null; });
    return loading;
  }
  return {
    getSnapshot: () => state,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    load,
    dismissError() { if (state.phase === 'load-error') publish({ dismissed: true }); },
    replay() { if ((state.phase === 'ready' && state.completed) || state.dismissed) publish({ replay: true }); },
    async finish() {
      if (state.saving) return;
      if (state.replay) { publish({ replay: false }); return; }
      if (state.phase !== 'ready' || state.completed) return;
      publish({ saving: true, error: null });
      try {
        await storage.setItem(ONBOARDING_KEY, JSON.stringify({ version: 1, completed: true }));
        publish({ completed: true, saving: false });
      } catch { publish({ saving: false, error: 'Не удалось сохранить. Повторите попытку — ваши записи не изменены.' }); }
    },
  };
}

export function onboardingVisible(state: OnboardingState): boolean {
  return state.replay || (!state.dismissed && (state.phase !== 'ready' || !state.completed));
}
