import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const spec = JSON.parse(await readFile(new URL("public/openapi.json", root), "utf8"));

function routeUrl(path) {
  const routePath = path.replace(/^\//, "").replace(/\{([^}]+)\}/g, "[$1]");
  return new URL(`app/${routePath}/route.ts`, root);
}

test("every OpenAPI operation has a matching Next route export", async () => {
  const operationIds = new Set();
  for (const [path, pathItem] of Object.entries(spec.paths)) {
    const source = await readFile(routeUrl(path), "utf8");
    for (const [method, operation] of Object.entries(pathItem)) {
      assert.match(source, new RegExp(`export const ${method.toUpperCase()}\\s*=`), `${method.toUpperCase()} ${path}`);
      assert.ok(operation.operationId, `${method.toUpperCase()} ${path} has no operationId`);
      assert.ok(!operationIds.has(operation.operationId), `duplicate operationId: ${operation.operationId}`);
      operationIds.add(operation.operationId);
    }
  }
});

test("state replacement uses an atomic D1 batch and derives task order from the array", async () => {
  const source = await readFile(new URL("app/api/v1/state/route.ts", root), "utf8");
  assert.match(source, /await db\.batch\(/);
  assert.doesNotMatch(source, /db\.transaction\(/);
  assert.match(source, /position: index/);
  assert.match(source, /chunks\(taskRows, 14\)/);
});

test("deploy packaging includes the generated migration directory", async () => {
  const plugin = await readFile(new URL("build/sites-vite-plugin.ts", root), "utf8");
  const migration = await readFile(new URL("db/migrations/0000_wandering_scarlet_spider.sql", root), "utf8");
  assert.match(plugin, /resolve\(root, "db", "migrations"\)/);
  assert.match(migration, /CREATE TABLE `tasks`/);
  assert.match(migration, /CREATE TABLE `reminder_logs`/);
});

test("API validators reject impossible dates and ambiguous reminder times", async () => {
  const source = await readFile(new URL("lib/api.ts", root), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const api = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);

  assert.equal(api.requireIsoDate("2028-02-29", "date"), "2028-02-29");
  assert.throws(() => api.requireIsoDate("2026-02-29", "date"), (error) => error.status === 400);
  assert.equal(api.readOptionalTime("23:59", "time"), "23:59");
  assert.throws(() => api.readOptionalTime("25:10", "time"), (error) => error.status === 400);
  assert.equal(api.requireIsoDateTime("2026-08-25T09:00:00+03:00", "dueAt"), "2026-08-25T06:00:00.000Z");
  assert.throws(() => api.requireIsoDateTime("2026-08-25T09:00:00", "dueAt"), (error) => error.status === 400);
  assert.equal(api.todayDate(new Date("2026-08-21T22:30:00.000Z"), "Europe/Kyiv"), "2026-08-22");
});

test("sync is adopted before an enabled config can arm automatic uploads", async () => {
  const source = await readFile(new URL("app/planner-app.tsx", root), "utf8");
  const updateStart = source.indexOf("async function updateApiConfig");
  const updateEnd = source.indexOf("useEffect(() =>", updateStart);
  const updateSource = source.slice(updateStart, updateEnd);
  assert.ok(updateSource.indexOf("await adoptServerState(next)") < updateSource.indexOf("setApiConfig(next)"));
});
