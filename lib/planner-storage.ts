const STORAGE_KEY = "personal-planner-v1";

export type StoredPlannerState = {
  tasks: unknown[];
  goals: unknown[];
  entries: unknown[];
  events: unknown[];
};

export function loadPlannerState(): StoredPlannerState | null {
  if (typeof window === "undefined") return null;
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return saved ? (JSON.parse(saved) as StoredPlannerState) : null;
  } catch {
    return null;
  }
}

export function savePlannerState(state: StoredPlannerState) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
