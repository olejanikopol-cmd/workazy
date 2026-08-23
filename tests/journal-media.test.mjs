import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";

const root = new URL("../", import.meta.url);

async function readSource(relativePath) {
  return readFile(new URL(relativePath, root), "utf8");
}

test("migration 0001 adds journal_media and makes journal body nullable without losing rows", async () => {
  const files = await readdir(new URL("db/migrations/", root));
  const migrationName = files.find((file) => file.startsWith("0001_") && file.endsWith(".sql"));
  assert.ok(migrationName, "миграция 0001 существует");
  const migration = await readSource(`db/migrations/${migrationName}`);

  assert.match(migration, /CREATE TABLE `journal_media`/);
  assert.match(migration, /`storage_key` text NOT NULL/);
  assert.match(migration, /`transcription_status` text DEFAULT 'pending' NOT NULL/);
  assert.match(migration, /CREATE INDEX `idx_journal_media_entry` ON `journal_media` \(`journal_entry_id`\)/);
  // body становится необязательным через пересоздание таблицы с переносом данных.
  assert.match(migration, /CREATE TABLE `__new_journal_entries`/);
  assert.match(migration, /INSERT INTO `__new_journal_entries`[\s\S]*SELECT[\s\S]*FROM `journal_entries`/);
  assert.match(migration, /ALTER TABLE `__new_journal_entries` RENAME TO `journal_entries`/);
  assert.match(migration, /PRAGMA foreign_keys=ON/);
});

test("migration 0001 preserves legacy journal rows in SQLite", async () => {
  const database = new DatabaseSync(":memory:");
  const base = await readSource("db/migrations/0000_wandering_scarlet_spider.sql");
  const media = await readSource("db/migrations/0001_hesitant_jazinda.sql");
  database.exec(base.split("--> statement-breakpoint").join("\n"));
  database.prepare("INSERT INTO journal_entries(id,date,title,body,mood,tags,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run("legacy-entry", "2026-08-23", "Старая запись", "Старый текст", "Спокойно", '["важное"]', "created", "updated");

  database.exec(media.split("--> statement-breakpoint").join("\n"));
  const legacy = { ...database.prepare("SELECT * FROM journal_entries WHERE id = ?").get("legacy-entry") };
  assert.deepEqual(legacy, {
    id: "legacy-entry",
    date: "2026-08-23",
    title: "Старая запись",
    body: "Старый текст",
    mood: "Спокойно",
    tags: '["важное"]',
    created_at: "created",
    updated_at: "updated",
  });
  database.prepare("INSERT INTO journal_entries(id,date,body,tags,created_at,updated_at) VALUES(?,?,?,?,?,?)")
    .run("media-only", "2026-08-24", null, "[]", "created", "updated");
  assert.equal(database.prepare("SELECT body FROM journal_entries WHERE id = ?").get("media-only").body, null);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('journal_media')").get().count, 18);
  database.close();
});

test("schema declares journal_media metadata without binary payloads", async () => {
  const schema = await readSource("db/schema.ts");
  assert.match(schema, /export const journalMedia = sqliteTable/);
  assert.match(schema, /storageKey: text\("storage_key"\)\.notNull\(\)/);
  assert.match(schema, /transcript: text\("transcript"\)/);
  // Бинарных колонок нет: файл живёт в R2, в D1 только ключ.
  assert.doesNotMatch(schema, /blob\(/);
});

test("upload route validates multipart form and guards oversized bodies before buffering", async () => {
  const route = await readSource("app/api/v1/journal/media/route.ts");
  assert.match(route, /multipart\/form-data/);
  assert.match(route, /content-length/);
  assert.match(route, /413/);
  assert.match(route, /requireOneOf\(form\.get\("type"\), "type", \["audio", "video"\]/);
  assert.match(route, /MAX_AUDIO_DURATION_MS|MAX_VIDEO_DURATION_MS/);
  assert.match(route, /audioTrackPart instanceof File/);
  assert.match(route, /mediaHeaderMatchesMime/);
  assert.match(route, /file\.size > maxFileSize/);
  assert.match(route, /audioTrackPart\.size > MAX_AUDIO_SIZE_BYTES/);
});

test("R2 streaming put enforces the size limit and cleans up failed objects", async () => {
  const r2 = await readSource("lib/r2.ts");
  assert.match(r2, /putStreamLimited/);
  assert.match(r2, /seen > options\.maxSizeBytes/);
  assert.match(r2, /controller\.error\(new ApiError\(413/);
  // Любая ошибка записи убирает начатый объект, чтобы не оставлять мусор.
  assert.match(r2, /await deleteObjectQuiet\(bucket, key\)/);
  // cloudflare:workers читается лениво — статический импорт ломал бы сборку.
  assert.match(r2, /await import\("cloudflare:workers"\)/);
  assert.doesNotMatch(r2, /^import .* from "cloudflare:workers"/m);
});

test("file route serves signed or bearer requests with HTTP Range support", async () => {
  const route = await readSource("app/api/v1/journal/media/[id]/file/route.ts");
  // Собственная авторизация вместо withApi: подпись или Bearer.
  assert.match(route, /verifyMediaToken\(id, sig\)/);
  assert.match(route, /requireApiToken\(request\)/);
  assert.doesNotMatch(route, /withApi\(/);
  assert.match(route, /parseRangeHeader/);
  assert.match(route, /status = 206/);
  assert.match(route, /"Accept-Ranges": "bytes"/);
  assert.match(route, /Content-Range/);
  // Байты идут потоком из R2, а не через память целиком.
  assert.match(route, /new Response\(object\.body/);
  assert.match(route, /contentLength = range\.end - range\.start \+ 1/);
  assert.match(route, /Cache-Control.*private, no-store/);
});

test("Range parser handles fixed, open-ended and suffix ranges", async () => {
  const route = await readSource("app/api/v1/journal/media/[id]/file/route.ts");
  const helper = route.slice(route.indexOf("function parseRangeHeader"), route.indexOf("export async function GET"));
  const output = ts.transpileModule(`${helper}\nexport { parseRangeHeader };`, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const ranges = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);

  assert.deepEqual(ranges.parseRangeHeader("bytes=10-19", 100), { start: 10, end: 19 });
  assert.deepEqual(ranges.parseRangeHeader("bytes=90-", 100), { start: 90, end: 99 });
  assert.deepEqual(ranges.parseRangeHeader("bytes=-10", 100), { start: 90, end: 99 });
  assert.equal(ranges.parseRangeHeader("bytes=100-", 100), null);
  assert.equal(ranges.parseRangeHeader("bytes=20-10", 100), null);
});

test("signed URLs are short-lived HMAC tokens bound to the media id", async () => {
  const sign = await readSource("lib/media-sign.ts");
  assert.match(sign, /MEDIA_SIGNATURE_TTL_MS = 5 \* 60_000/);
  assert.match(sign, /HMAC/);
  // Подпись привязана к конкретному файлу и сроку действия.
  assert.match(sign, /\$\{mediaId\}:\$\{expiresAtMs\}/);
  assert.match(sign, /expiresAtMs > nowMs \+ MEDIA_SIGNATURE_TTL_MS/);
  assert.match(sign, /timingSafeEqual/);
  // Секрет в URL не попадает: в токене только срок и хэш.
  assert.doesNotMatch(sign, /sig=.*WORKAZY_API_TOKEN|WORKAZY_API_TOKEN.*sig=/);
});

test("state sync attaches media and prunes only orphaned files after replacement", async () => {
  const route = await readSource("app/api/v1/state/route.ts");
  assert.match(route, /attachEntryMedia\(entryRows\.map\(entryToJson\), mediaByEntry\)/);
  assert.match(route, /await pruneOrphanedMedia\(entryRows\.map\(\(row\) => row\.id\)\)/);
  // Медиа записи больше не требуют обязательного текста.
  assert.match(route, /readOptionalText\(item\.body/);

  const service = await readSource("lib/journal-media.ts");
  assert.match(service, /const orphans = rows\.filter\(\(row\) => !keep\.has\(row\.journalEntryId\)\)/);

  const api = await readSource("lib/api.ts");
  assert.match(api, /body: row\.body \?\? ""/, "media-only entry всегда сериализуется со строковым body");
});

test("deleting an entry removes its media rows and R2 objects first", async () => {
  const route = await readSource("app/api/v1/journal/[id]/route.ts");
  const deleteBlock = route.slice(route.indexOf("export const DELETE"));
  const mediaDelete = deleteBlock.indexOf("deleteMediaForEntries([id])");
  const entryDelete = deleteBlock.indexOf("db.delete(journalEntries)");
  assert.ok(mediaDelete !== -1 && entryDelete !== -1 && mediaDelete < entryDelete);
  // Очистить текст можно только если остались аудио или видео.
  assert.match(route, /Текст записи нельзя очистить, пока в ней нет аудио или видео/);
});

test("transcription failures keep the saved file and video retries never use the full video", async () => {
  const service = await readSource("lib/journal-media.ts");
  const transcribe = service.slice(service.indexOf("export async function transcribeJournalMedia"));
  // Сбой фиксируется статусом, а не удалением файла.
  assert.match(transcribe, /transcriptionStatus: "error", transcriptionError: message/);
  assert.doesNotMatch(transcribe.slice(0, transcribe.indexOf("catch")), /deleteJournalMedia/);
  // Отдельный трек остаётся для retry, а fallback на полный видеофайл запрещён.
  const successBlock = transcribe.slice(0, transcribe.indexOf("} catch"));
  assert.match(successBlock, /row\.type === "video" && !row\.transcriptionInputKey/);
  assert.match(successBlock, /row\.type === "video" \? row\.transcriptionInputKey as string : row\.storageKey/);
  assert.doesNotMatch(successBlock, /changes\.transcriptionInputKey = null/);
  assert.doesNotMatch(successBlock, /deleteR2Objects\(\[row\.transcriptionInputKey\]\)/);
});

test("Groq provider talks to api.groq.com directly with whisper-large-v3-turbo", async () => {
  const provider = await readSource("lib/transcription/groq.ts");
  assert.match(provider, /https:\/\/api\.groq\.com\/openai\/v1\/audio\/transcriptions/);
  assert.match(provider, /whisper-large-v3-turbo/);
  // Официальный OpenAI SDK не используется.
  assert.doesNotMatch(provider, /from "openai"/);

  const factory = await readSource("lib/transcription/provider.ts");
  assert.match(factory, /GROQ_API_KEY/);
  assert.doesNotMatch(factory, /OPENAI_API_KEY/);
});

test("client uploads media with progress and keeps binary payloads out of planner state", async () => {
  const api = await readSource("lib/planner-api.ts");
  assert.match(api, /XMLHttpRequest/);
  assert.match(api, /xhr\.upload\.addEventListener\("progress"/);
  assert.match(api, /input\.signal\?\.addEventListener\("abort", abortUpload/);
  assert.match(api, /form\.append\("file", input\.file, input\.fileName\)/);
  assert.match(api, /\/api\/v1\/journal\/media/);
  // Ссылка на байты запрашивается отдельно и живёт ограниченное время.
  assert.match(api, /file-url/);

  const screen = await readSource("app/secondary-screens.tsx");
  // В запись попадают только серверные метаданные, а не блобы черновиков.
  assert.match(screen, /drafts\.map\(\(draft\) => draft\.server\)/);
});

test("backup builder never receives tokens or secrets", async () => {
  const backup = await readSource("lib/journal-export.ts");
  assert.doesNotMatch(backup, /token/i);
  assert.doesNotMatch(backup, /apiKey|api_key|secret/i);
  assert.match(backup, /buildBackupManifest/);
  assert.match(backup, /journal\/manifest\.json/);
  assert.match(backup, /journal\/media\/\$\{entry\.id\}\/\$\{mediaFileName\(media\)\}/);
});
