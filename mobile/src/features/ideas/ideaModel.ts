/**
 * Pure idea mutations, validation, labels and selectors.
 *
 * Stored order is the display order (new ideas prepend, edits and status changes
 * keep their position) — matching the web client instead of the inconsistent
 * filtered/unfiltered API sorting. Category and status are the live product
 * values with their existing labels; `plan` never creates a PlanTask/Goal and
 * `archive` stays stored and reachable.
 *
 * Input rules (visible errors, no TextInput truncation):
 * - title: required, outer trim, max 300;
 * - description: optional, outer trim, blank -> omitted, max 2000.
 */
import type { Idea, IdeaCategory, IdeaStatus } from '@/types/idea';
import { IDEA_CATEGORIES, IDEA_STATUSES } from '@/storage/ideaStorage';

export const IDEA_TITLE_MAX_LENGTH = 300;
export const IDEA_DESCRIPTION_MAX_LENGTH = 2000;

export const IDEA_CATEGORY_LABELS: Record<IdeaCategory, string> = {
  thought: 'Мысль',
  want: 'Хочуха',
  project: 'Проект',
  purchase: 'Покупка',
  someday: 'Когда-нибудь',
};

export const IDEA_STATUS_LABELS: Record<IdeaStatus, string> = {
  new: 'Новая',
  thinking: 'Думаю',
  plan: 'В план',
  done: 'Сделано',
  archive: 'Архив',
};

export const DEFAULT_IDEA_CATEGORY: IdeaCategory = 'thought';
export const DEFAULT_IDEA_STATUS: IdeaStatus = 'new';

/** Ordered values for the filter rows and pickers. */
export const ideaCategoryOptions = IDEA_CATEGORIES;
export const ideaStatusOptions = IDEA_STATUSES;

export type IdeaValidationReason =
  | 'validation'
  | 'missing'
  | 'title-blank'
  | 'title-too-long'
  | 'description-too-long';

export type IdeaValidationFailure = { ok: false; reason: IdeaValidationReason };

export type IdeasResult =
  | { ok: true; ideas: readonly Idea[] }
  | IdeaValidationFailure;

export type AddIdeaResult =
  | { ok: true; ideas: readonly Idea[]; idea: Idea }
  | IdeaValidationFailure;


/**
 * Which editor fields the user actually changed. Only changed fields are
 * validated/normalized; untouched committed values (including legacy overlength
 * titles/descriptions and present-but-empty descriptions) are preserved exactly.
 */
export type IdeaFieldChanges = {
  title: boolean;
  description: boolean;
  category: boolean;
  status: boolean;
};

export type IdeaInput = {
  title: string;
  description: string;
  category: IdeaCategory;
  status: IdeaStatus;
  changed: IdeaFieldChanges;
};

const ALL_IDEA_FIELDS: IdeaFieldChanges = {
  title: true,
  description: true,
  category: true,
  status: true,
};

export type AddIdeaInput = IdeaInput & { id: string; now: Date };

function trimmedOrUndefined(raw: string): string | undefined {
  const value = raw.trim();
  return value.length === 0 ? undefined : value;
}

export function validateIdeaTitle(raw: string): { ok: true; title: string } | IdeaValidationFailure {
  const title = raw.trim();
  if (title.length === 0) return { ok: false, reason: 'title-blank' };
  if (title.length > IDEA_TITLE_MAX_LENGTH) return { ok: false, reason: 'title-too-long' };
  return { ok: true, title };
}

export function validateIdeaDescription(
  raw: string,
): { ok: true; description?: string } | IdeaValidationFailure {
  const description = trimmedOrUndefined(raw);
  if (description !== undefined && description.length > IDEA_DESCRIPTION_MAX_LENGTH) {
    return { ok: false, reason: 'description-too-long' };
  }
  return description === undefined ? { ok: true } : { ok: true, description };
}

function buildFields(
  input: IdeaInput,
  existing: Idea | undefined,
  forceAll: boolean,
):
  | { ok: true; title: string; description?: string; category: IdeaCategory; status: IdeaStatus }
  | IdeaValidationFailure {
  const changed = forceAll ? ALL_IDEA_FIELDS : input.changed;

  // Title: a changed value must satisfy the input limit; an untouched legacy
  // title (even above 300) is copied through so it cannot block other edits.
  let title: string;
  if (changed.title || existing === undefined) {
    const validated = validateIdeaTitle(input.title);
    if (!validated.ok) return validated;
    title = validated.title;
  } else {
    title = existing.title;
  }

  // Description: same rule — an untouched legacy/blank description survives.
  let description: string | undefined = existing?.description;
  if (changed.description || existing === undefined) {
    const validated = validateIdeaDescription(input.description);
    if (!validated.ok) return validated;
    description = validated.description;
  }

  let category: IdeaCategory = existing?.category ?? DEFAULT_IDEA_CATEGORY;
  if (changed.category || existing === undefined) {
    if (!IDEA_CATEGORIES.includes(input.category)) return { ok: false, reason: 'validation' };
    category = input.category;
  }

  let status: IdeaStatus = existing?.status ?? DEFAULT_IDEA_STATUS;
  if (changed.status || existing === undefined) {
    if (!IDEA_STATUSES.includes(input.status)) return { ok: false, reason: 'validation' };
    status = input.status;
  }

  return { ok: true, title, description, category, status };
}

/** Prepend a new idea; both timestamps share the same canonical UTC instant. */
export function addIdea(ideas: readonly Idea[], input: AddIdeaInput): AddIdeaResult {
  const fields = buildFields(input, undefined, true);
  if (!fields.ok) return fields;
  const nowIso = input.now.toISOString();
  const idea: Idea = {
    id: input.id,
    title: fields.title,
    category: fields.category,
    status: fields.status,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  if (fields.description !== undefined) idea.description = fields.description;
  return { ok: true, ideas: [idea, ...ideas], idea };
}

/** Edit in place: id, createdAt and stored position are preserved exactly. */
export function editIdea(
  ideas: readonly Idea[],
  id: string,
  input: IdeaInput,
  now: Date,
): IdeasResult {
  const existing = ideas.find((idea) => idea.id === id);
  if (!existing) return { ok: false, reason: 'missing' };
  const fields = buildFields(input, existing, false);
  if (!fields.ok) return fields;
  // Start from the committed row and apply ONLY the changed fields.
  const next: Idea = { ...existing, updatedAt: now.toISOString() };
  if (input.changed.title) next.title = fields.title;
  if (input.changed.category) next.category = fields.category;
  if (input.changed.status) next.status = fields.status;
  if (input.changed.description) {
    if (fields.description === undefined) delete next.description;
    else next.description = fields.description;
  }
  return { ok: true, ideas: ideas.map((idea) => (idea.id === id ? next : idea)) };
}

/** Quick status change (web inline select): position and other fields untouched. */
export function setIdeaStatus(
  ideas: readonly Idea[],
  id: string,
  status: IdeaStatus,
  now: Date,
): IdeasResult {
  if (!ideas.some((idea) => idea.id === id)) return { ok: false, reason: 'missing' };
  if (!IDEA_STATUSES.includes(status)) return { ok: false, reason: 'validation' };
  return {
    ok: true,
    ideas: ideas.map((idea) =>
      idea.id === id ? { ...idea, status, updatedAt: now.toISOString() } : idea,
    ),
  };
}

export function removeIdea(ideas: readonly Idea[], id: string): IdeasResult {
  if (!ideas.some((idea) => idea.id === id)) return { ok: false, reason: 'missing' };
  return { ok: true, ideas: ideas.filter((idea) => idea.id !== id) };
}

/** UI-only filters; `all` means no constraint. Both filters combine with AND. */
export type IdeaFilters = {
  category: IdeaCategory | 'all';
  status: IdeaStatus | 'all';
};

export function filterIdeas(ideas: readonly Idea[], filters: IdeaFilters): Idea[] {
  return ideas.filter((idea) => {
    if (filters.category !== 'all' && idea.category !== filters.category) return false;
    if (filters.status !== 'all' && idea.status !== filters.status) return false;
    return true;
  });
}
