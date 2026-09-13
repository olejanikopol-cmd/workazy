/**
 * Local-day and sheet-identity helpers for Finance (Slice 6A fixes).
 *
 * `createFinanceDayController` samples an INJECTED clock: it survives app
 * foreground, Finance focus and an open app across midnight, and reports a day
 * change exactly once per new local date. `createDateDraft` / `effectiveDate` keep a
 * form's default date authoritative (untouched drafts adopt the NEW local today at
 * submit time) while an explicitly chosen date is preserved.
 *
 * `createSheetRegistry` gives every opened mutable sheet a stable instance identity,
 * the entity it edits and the committed revision it was opened on, so a late async
 * completion can never close a newer sheet and a submit can never silently use a
 * newer revision.
 */
import { localDateIso } from './financeDates';

export type FinanceDayController = {
  /** Samples the clock; returns the current local date and whether it changed. */
  sample(): { today: string; changed: boolean };
  current(): string;
};

export function createFinanceDayController(input: {
  now: () => Date;
  initialDate?: string;
  onDayChange?: (today: string) => void;
}): FinanceDayController {
  let currentDate = input.initialDate ?? localDateIso(input.now());
  return {
    sample() {
      const today = localDateIso(input.now());
      const changed = today !== currentDate;
      if (changed) {
        currentDate = today;
        input.onDayChange?.(today);
      }
      return { today, changed };
    },
    current: () => currentDate,
  };
}

export type DateDraft = {
  value: string;
  /** True only after the user picked/typed a date explicitly. */
  touched: boolean;
};

/** A new form starts with today's date, marked untouched. */
export function createDateDraft(today: string): DateDraft {
  return { value: today, touched: false };
}

/** User interaction marks the draft as explicit (a stale day is never posted). */
export function setDateDraft(_draft: DateDraft, value: string): DateDraft {
  return { value, touched: true };
}

/**
 * The date a form must submit: an UNTOUCHED draft resolves to the CURRENT local
 * today (so a form opened at 23:59 and saved at 00:01 posts to the new day), while
 * an explicit choice is preserved exactly.
 */
export function effectiveDate(draft: DateDraft, today: string): string {
  return draft.touched ? draft.value : today;
}

/**
 * The date a FORM must submit for a touched-flag field: an UNTOUCHED default
 * resolves to the CURRENT local today (a form opened before midnight and saved
 * after it posts to the new day and never to stale yesterday), while an explicit
 * selection is preserved exactly.
 */
export function resolveFormDate(input: {
  touched: boolean;
  value: string;
  today: string;
}): string {
  return input.touched ? input.value : input.today;
}

/**
 * The date a FORM must submit, sampled AT SUBMIT TIME from the injected/current
 * clock (never from the last render or a periodic tick):
 *
 * - the user never changed the default date => the CURRENT local date is used (a form
 *   opened at 23:59 and saved at 00:01 posts to the new day, not stale yesterday);
 * - the user explicitly chose a date => that exact date is preserved.
 *
 * `originalDefaultDate` is the date the field was defaulted to when the sheet opened,
 * `currentDraftDate` is what the field currently shows.
 */
export function resolveSubmittedFinanceDate(input: {
  originalDefaultDate: string;
  currentDraftDate: string;
  wasDateTouched: boolean;
  nowLocalDate: string;
}): string {
  if (input.wasDateTouched) return input.currentDraftDate;
  return input.nowLocalDate;
}

/** Refresh across midnight: an untouched draft silently adopts the new today. */
export function adoptToday(draft: DateDraft, today: string): DateDraft {
  return draft.touched || draft.value === today ? draft : { value: today, touched: false };
}

export type SheetInstance = {
  /** Monotonic identity of THIS opened sheet. */
  instanceId: number;
  /** Entity being edited (null when creating). */
  entityId: string | null;
  /** Committed revision captured when the sheet was opened. */
  revision: number;
};

export type SheetRegistry = {
  open(entityId: string | null, revision: number): SheetInstance;
  current(): SheetInstance | null;
  /** True when the completion belongs to the sheet that is still open. */
  isCurrent(instanceId: number): boolean;
  /** Closes only the matching instance; a newer sheet is never closed. */
  close(instanceId: number): boolean;
  closeCurrent(): void;
};

export function createSheetRegistry(): SheetRegistry {
  let nextId = 1;
  let open: SheetInstance | null = null;
  return {
    open(entityId, revision) {
      open = { instanceId: nextId, entityId, revision };
      nextId += 1;
      return open;
    },
    current: () => open,
    isCurrent(instanceId) {
      return open !== null && open.instanceId === instanceId;
    },
    close(instanceId) {
      if (open === null || open.instanceId !== instanceId) return false;
      open = null;
      return true;
    },
    closeCurrent() {
      open = null;
    },
  };
}

/** Preserve untouched imported text; normalize only actual user edits. */
export function submittedText(value: string, touched: boolean): string {
  return touched ? value.trim() : value;
}

export function submittedOptionalText(
  value: string,
  touched: boolean,
  original?: string,
): string | undefined {
  if (!touched && original !== undefined) return original;
  if (touched) return value.trim().length === 0 ? undefined : value.trim();
  return value.length === 0 ? undefined : value;
}
