const STORAGE_KEY = "personal-planner-v1";

export type StoredPlannerState = {
  tasks: unknown[];
  assignments: unknown[];
  goals: unknown[];
  entries: unknown[];
  events: unknown[];
  ideas: unknown[];
  finances?: unknown;
  savedAt?: string;
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

export function savePlannerState(state: StoredPlannerState, savedAt = new Date().toISOString()): string {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, savedAt }));
  }
  return savedAt;
}
