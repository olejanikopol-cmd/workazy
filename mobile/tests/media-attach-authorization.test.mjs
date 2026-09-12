import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeAttach } from '../src/services/media/attachAuthorization.ts';

const LIVE = { sheetKey: 'sheet-A', entryId: null, draftKey: 'draft-A', draftRevision: 3 };
const OWNER = { ...LIVE, sessionId: 'session-A', generation: 7 };

function context(overrides = {}) {
  return {
    captured: OWNER,
    current: OWNER,
    live: LIVE,
    parentIsCurrent: true,
    editorBusy: false,
    mounted: true,
    ...overrides,
  };
}

test('the render-lag window: a synchronously replaced editor refuses BEFORE adoption', () => {
  // The parent has ALREADY made B the current sheet (its synchronous ref moved),
  // while the overlay's own live getter and the controller still describe A. No
  // rendered prop has caught up yet.
  const refused = authorizeAttach(context({ parentIsCurrent: false }));
  assert.equal(refused?.code, 'busy');
  // The take must therefore never be adopted/promoted.
  assert.equal(refused?.message.length > 0, true);

  // B's own recorder is independent and may attach.
  const ownerB = { sheetKey: 'sheet-B', entryId: null, draftKey: 'draft-B', draftRevision: 1, sessionId: 'session-B', generation: 9 };
  assert.equal(
    authorizeAttach({
      captured: ownerB,
      current: ownerB,
      live: { sheetKey: 'sheet-B', entryId: null, draftKey: 'draft-B', draftRevision: 1 },
      parentIsCurrent: true,
      editorBusy: false,
      mounted: true,
    }),
    null,
  );
});

test('every authoritative source is consulted (busy, revision, session, mount, identity)', () => {
  assert.equal(authorizeAttach(context()), null); // the live recorder may attach
  assert.equal(authorizeAttach(context({ editorBusy: true }))?.code, 'busy');
  assert.equal(authorizeAttach(context({ live: { ...LIVE, draftRevision: 4 } }))?.code, 'busy');
  assert.equal(authorizeAttach(context({ live: { ...LIVE, draftKey: 'other' } }))?.code, 'busy');
  assert.equal(authorizeAttach(context({ live: { ...LIVE, sheetKey: 'sheet-Z' } }))?.code, 'busy');
  assert.equal(authorizeAttach(context({ live: { ...LIVE, entryId: 'entry-1' } }))?.code, 'busy');
  assert.equal(authorizeAttach(context({ mounted: false }))?.code, 'cancelled');
  assert.equal(authorizeAttach(context({ current: null }))?.code, 'cancelled');
  assert.equal(authorizeAttach(context({ captured: null }))?.code, 'cancelled');
  // A replaced session (same kind, new generation) is never attachable.
  assert.equal(
    authorizeAttach(context({ current: { ...OWNER, generation: OWNER.generation + 1 } }))?.code,
    'cancelled',
  );
  assert.equal(
    authorizeAttach(context({ current: { ...OWNER, sessionId: 'session-A2' } }))?.code,
    'cancelled',
  );
});
