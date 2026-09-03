import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const spec = JSON.parse(await readFile(new URL("public/openapi.json", root), "utf8"));
const gptSpec = JSON.parse(await readFile(new URL("public/openapi-gpt.json", root), "utf8"));

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

test("Custom GPT OpenAPI stays focused and below the 30-operation limit", async () => {
  const operations = [];
  for (const [path, pathItem] of Object.entries(gptSpec.paths)) {
    const source = await readFile(routeUrl(path), "utf8");
    for (const [method, operation] of Object.entries(pathItem)) {
      assert.match(source, new RegExp(`export const ${method.toUpperCase()}\\s*=`), `${method.toUpperCase()} ${path}`);
      operations.push({ path, operationId: operation.operationId });
    }
  }

  assert.ok(operations.length <= 30, `Custom GPT schema has ${operations.length} operations`);
  assert.equal(new Set(operations.map((operation) => operation.operationId)).size, operations.length);
  assert.equal(gptSpec.servers[0].url, "https://personal-planner.uchepir.chatgpt.site");
  assert.deepEqual(gptSpec.security, [{ BearerAuth: [] }]);
  assert.equal(gptSpec.components.securitySchemes.BearerAuth.scheme, "bearer");
  assert.ok(gptSpec.paths["/api/v1/assignments"]);
  assert.equal(gptSpec.paths["/api/v1/tasks"], undefined, "Custom GPT must not write assignments into the daily plan");
  assert.doesNotMatch(
    operations.map((operation) => `${operation.path} ${operation.operationId}`).join("\n"),
    /media|upload|file-url|reminder|health|storage/i,
  );
});

test("legacy Custom GPT task routes are safe aliases for assignments", async () => {
  const list = await readFile(new URL("app/api/v1/tasks/route.ts", root), "utf8");
  const item = await readFile(new URL("app/api/v1/tasks/[id]/route.ts", root), "utf8");
  const complete = await readFile(new URL("app/api/v1/tasks/[id]/complete/route.ts", root), "utf8");
  for (const source of [list, item, complete]) {
    assert.match(source, /assignments/);
    assert.doesNotMatch(source, /from\(tasks\)|insert\(tasks\)|update\(tasks\)|delete\(tasks\)/);
  }
  assert.match(list, /newId\("assignment"\)/);
  assert.doesNotMatch(list, /body\.date|todayDate/);
});

test("the failed GPT attempts are deduplicated into one assignment", async () => {
  const source = await readFile(new URL("lib/legacy-assignments.ts", root), "utf8");
  assert.match(source, /task-1787803987213-sc2cw/);
  assert.match(source, /task-1787804044422-hbf3k/);
  assert.match(source, /task-1787804090419-h83vh/);
  assert.match(source, /db\.insert\(assignments\)/);
  assert.match(source, /db\.delete\(tasks\)/);
  assert.match(source, /await db\.batch\(/);
});

test("state replacement keeps assignments separate and uses an atomic D1 batch", async () => {
  const source = await readFile(new URL("app/api/v1/state/route.ts", root), "utf8");
  assert.match(source, /await db\.batch\(/);
  assert.doesNotMatch(source, /db\.transaction\(/);
  assert.match(source, /position: index/);
  assert.match(source, /chunks\(taskRows, 14\)/);
  assert.match(source, /db\.delete\(assignments\)/);
  assert.match(source, /db\.insert\(assignments\)/);
});

test("deploy packaging includes the generated migration directory", async () => {
  const plugin = await readFile(new URL("build/sites-vite-plugin.ts", root), "utf8");
  const build = await readFile(new URL("scripts/build-verified.sh", root), "utf8");
  const verify = await readFile(new URL("scripts/verify-sites-artifact.mjs", root), "utf8");
  const migration = await readFile(new URL("db/migrations/0000_wandering_scarlet_spider.sql", root), "utf8");
  const assignmentMigration = await readFile(new URL("db/migrations/0002_opposite_kitty_pryde.sql", root), "utf8");
  assert.match(plugin, /resolve\(root, "db", "migrations"\)/);
  assert.match(build, /verify-sites-artifact\.mjs/);
  assert.match(verify, /0001_hesitant_jazinda\.sql/);
  assert.match(verify, /0002_opposite_kitty_pryde\.sql/);
  assert.match(verify, /hosting\.d1 !== "DB" \|\| hosting\.r2 !== "MEDIA"/);
  assert.match(migration, /CREATE TABLE `tasks`/);
  assert.match(migration, /CREATE TABLE `reminder_logs`/);
  assert.match(assignmentMigration, /CREATE TABLE `assignments`/);
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
  assert.equal(api.readQueryBool("true", "completed"), true);
  assert.equal(api.readQueryBool("false", "completed"), false);
  assert.equal(api.readQueryBool(null, "completed"), undefined);
  assert.throws(() => api.readQueryBool("1", "completed"), (error) => error.status === 400);
  assert.equal(api.requireIsoDateTime("2026-08-25T09:00:00+03:00", "dueAt"), "2026-08-25T06:00:00.000Z");
  assert.throws(() => api.requireIsoDateTime("2026-08-25T09:00:00", "dueAt"), (error) => error.status === 400);
  assert.equal(api.todayDate(new Date("2026-08-21T22:30:00.000Z"), "Europe/Kyiv"), "2026-08-22");
});

test("weekly summary uses Monday through Sunday across month and year boundaries", async () => {
  const source = await readFile(new URL("app/api/v1/summary/weekly/route.ts", root), "utf8");
  assert.doesNotMatch(source, /from\(ideas\)/);
  const helpers = source.slice(source.indexOf("function formatIso"), source.indexOf("export const GET"));
  const output = ts.transpileModule(`${helpers}\nexport { mondayOf, shiftDays };`, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const weekly = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);

  assert.equal(weekly.mondayOf("2026-08-17"), "2026-08-17");
  assert.equal(weekly.mondayOf("2026-08-23"), "2026-08-17");
  assert.equal(weekly.mondayOf("2027-01-01"), "2026-12-28");
  assert.equal(weekly.shiftDays("2026-12-28", 6), "2027-01-03");
});

test("sync is adopted before an enabled config can arm automatic uploads", async () => {
  const source = await readFile(new URL("app/planner-app.tsx", root), "utf8");
  const updateStart = source.indexOf("async function updateApiConfig");
  const updateEnd = source.indexOf("useEffect(() =>", updateStart);
  const updateSource = source.slice(updateStart, updateEnd);
  assert.ok(updateSource.indexOf("await adoptServerState(normalized)") < updateSource.indexOf("setApiConfig(normalized)"));
});

test("planner sync is automatic, durable during page exit, and conflict-aware", async () => {
  const api = await readFile(new URL("lib/planner-api.ts", root), "utf8");
  const app = await readFile(new URL("app/planner-app.tsx", root), "utf8");
  const route = await readFile(new URL("app/api/v1/state/route.ts", root), "utf8");

  assert.match(api, /enabled: true/);
  assert.match(api, /keepalive: true/);
  assert.match(api, /fetchSyncWithRetry/);
  assert.match(api, /mergePlannerStates/);
  assert.match(api, /syncUpdatedAt/);
  assert.match(app, /pagehide/);
  assert.match(app, /visibilitychange/);
  assert.match(route, /planner-sync-updated-at/);
  assert.match(route, /onConflictDoUpdate/);
});

test("same-origin owner authentication removes the manual token setup", async () => {
  const auth = await readFile(new URL("lib/api.ts", root), "utf8");
  const settings = await readFile(new URL("app/secondary-screens.tsx", root), "utf8");

  assert.match(auth, /oai-authenticated-user-email/);
  assert.match(auth, /WORKAZY_OWNER_EMAIL/);
  assert.match(settings, /Workazy Cloud/);
  assert.match(settings, /Подключено автоматически/);
  assert.doesNotMatch(settings, /Адрес сервера|API-токен|Включить синхронизацию/);
});

test("same-origin cloud writes do not wait for legacy token or server fields", async () => {
  const screens = await readFile(new URL("app/secondary-screens.tsx", root), "utf8");

  assert.equal(
    screens.match(/const syncEnabled = apiConfig\.enabled;/g)?.length,
    2,
    "задания и медиа используют автоматическое подключение Workazy Cloud",
  );
  assert.doesNotMatch(screens, /Boolean\(apiConfig\.(?:token|baseUrl)\)/);
  assert.doesNotMatch(screens, /Ждёт включения синхронизации|Включи синхронизацию/);
});
