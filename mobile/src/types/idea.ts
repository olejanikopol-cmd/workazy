/**
 * Idea domain types for the native app.
 *
 * Compatible with repository `lib/types.ts` (`Idea`, `IdeaCategory`,
 * `IdeaStatus`); no runtime import from the web app. Category/status values are
 * the live product semantics — do not rename or reorder them.
 *
 * Timestamps are REQUIRED here and are strict canonical UTC (unlike the web
 * Ideas client, which derives date-only `todayIso()` metadata).
 */
export type IdeaCategory = 'thought' | 'want' | 'project' | 'purchase' | 'someday';

export type IdeaStatus = 'new' | 'thinking' | 'plan' | 'done' | 'archive';

export type Idea = {
  id: string;
  title: string;
  description?: string;
  category: IdeaCategory;
  status: IdeaStatus;
  createdAt: string;
  updatedAt: string;
};

/** Persisted envelope under the single native key `workazy-native-ideas-v1`. */
export type IdeasSnapshotV1 = {
  version: 1;
  ideas: Idea[];
  /** ISO timestamp captured for the snapshot write. */
  savedAt: string;
};
