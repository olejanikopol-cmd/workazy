/**
 * Production wiring for local journal media.
 *
 * Builds the ONE shared local media repository and the ONE journal media
 * coordinator over the singleton journal store, and tracks the CURRENT editor/
 * recorder owner used by the coordinator's identity checks.
 *
 * Import boundary: this module plus `expoMediaFiles.ts`, `expoRecorderBindings.ts`
 * and the recorder/player components are the only media modules that touch Expo.
 */
import { journalStore } from '@/features/journal/useJournalStore';
import { createExpoMediaFilePort } from './expoMediaFiles';
import { randomUuid } from './expoRecorderBindings';
import { createJournalMediaCoordinator } from './journalMediaCoordinator';
import { createLocalMediaRepository } from './localMediaRepository';
import type { DraftIdentity, LocalMediaDraft } from './mediaContracts';

export const mediaRepository = createLocalMediaRepository({
  port: createExpoMediaFilePort(),
  createMediaId: () => `local-media-${randomUuid()}`,
  createSessionId: () => `session-${randomUuid()}`,
  now: () => new Date(),
});

let currentDraftOwner: DraftIdentity | null = null;

/**
 * Registered SYNCHRONOUSLY by the open journal sheet on every render (and
 * cleared on unmount). The coordinator compares against this live identity, so a
 * superseded sheet or a changed draft revision can never write media metadata.
 */
export function registerJournalDraftOwner(identity: DraftIdentity | null): void {
  currentDraftOwner = identity;
}

export function getCurrentJournalDraftOwner(): DraftIdentity | null {
  return currentDraftOwner;
}

/**
 * Explicitly abandon uncommitted draft takes: release their leases and remove only
 * their own staging/promoted files. Committed references always win, so a take
 * that was actually committed is never deleted here.
 */
export async function abandonStagedDrafts(drafts: readonly LocalMediaDraft[]): Promise<void> {
  if (drafts.length === 0) return;
  try {
    await mediaCoordinator.abandonDrafts(drafts);
  } catch {
    // Cleanup stays retryable: the files remain owned and discoverable by the
    // next sweep, which prefers leaking over deleting something needed.
  }
}

/** Protects a live recorder's staging directory from sweeps while it is open. */
export function leaseRecorderSession(sessionId: string): void {
  mediaCoordinator.leaseSession(sessionId);
}

/** Releases that protection when the recorder surface closes. */
export function releaseRecorderSession(sessionId: string): void {
  mediaCoordinator.releaseSession(sessionId);
}

/** Protects an adopted, still-unsaved draft take (its lease follows the draft). */
export function leaseDraftMedia(draft: LocalMediaDraft): void {
  mediaCoordinator.lease(draft);
}

/** Releases draft leases once the media is committed or explicitly abandoned. */
export function releaseDraftMedia(mediaIds: readonly string[]): void {
  for (const mediaId of mediaIds) mediaCoordinator.releaseLease(mediaId);
}

export const mediaCoordinator = createJournalMediaCoordinator({
  repository: mediaRepository,
  store: journalStore,
  currentOwner: getCurrentJournalDraftOwner,
});
