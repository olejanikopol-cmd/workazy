import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";

const appSource = await readFile(new URL("../app/planner-app.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("plan task card toggles outside the checkbox only when menu controls are not clicked", () => {
  assert.match(appSource, /function handleTaskCardClick/);
  assert.match(appSource, /target\.closest\("button, input, label, \.task-menu"\)/);
  assert.match(appSource, /role="checkbox"/);
  assert.match(appSource, /aria-checked=\{task\.completed\}/);
  assert.doesNotMatch(appSource, /<article[^>]*\sdraggable[\s=>]/);
});

test("task action menu can open upward near the bottom navigation", () => {
  assert.match(appSource, /setMenuPlacement\(spaceBelow < menuHeight && spaceAbove > spaceBelow \? "up" : "down"\)/);
  assert.match(cssSource, /\.task-menu\.drop-up \.task-menu-popover/);
  assert.match(cssSource, /bottom: 37px/);
});

test("plan task rows stay compact on mobile", () => {
  assert.match(cssSource, /\.task-card \{ min-height: 60px/);
  assert.match(cssSource, /\.task-body p \{[^}]*font-size: 13px/s);
  assert.match(cssSource, /\.task-body p \{[^}]*-webkit-line-clamp: 2/s);
});
