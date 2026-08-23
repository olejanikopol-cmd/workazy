import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";

const root = new URL("../", import.meta.url);

async function readSource(relativePath) {
  return readFile(new URL(relativePath, root), "utf8");
}

async function importPureTypeScript(relativePath) {
  const source = await readSource(relativePath);
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("migration 0001 adds journal_media and makes journal body nullable without losing rows", async () => {
  const files = await readdir(new URL("db/migrations/", root));
  const migrationName = files.find((file) => file.startsWith("0001_") && file.endsWith(".sql"));
  assert.ok(migrationName, "миграция 0001 существует");
  const migration = await readSource(`db/migrations/${migrationName}`);

  assert.match(migration, /CREATE TABLE IF NOT EXISTS `journal_media`/);
  assert.match(migration, /`storage_key` text NOT NULL/);
  assert.match(migration, /`transcription_status` text DEFAULT 'pending' NOT NULL/);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS `idx_journal_media_entry` ON `journal_media` \(`journal_entry_id`\)/);
  // body становится необязательным через пересоздание таблицы с переносом данных.
  assert.match(migration, /CREATE TABLE `__new_journal_entries`/);
  assert.match(migration, /INSERT INTO `__new_journal_entries`[\s\S]*SELECT[\s\S]*FROM `journal_entries`/);
  assert.match(migration, /ALTER TABLE `__new_journal_entries` RENAME TO `journal_entries`/);
  assert.match(migration, /PRAGMA foreign_keys=ON/);
});

test("runtime schema repair handles a missing 0001 without losing legacy rows", async () => {
  const schemaSql = await importPureTypeScript("lib/storage-schema.ts");
  const database = new DatabaseSync(":memory:");
  const base = await readSource("db/migrations/0000_wandering_scarlet_spider.sql");
  database.exec(base.split("--> statement-breakpoint").join("\n"));
  database.prepare("INSERT INTO journal_entries(id,date,title,body,tags,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
    .run("legacy", "2026-08-24", "До миграции", "Текст", "[]", "created", "updated");

  assert.equal(database.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name='journal_media'").get().count, 0);
  assert.equal(database.prepare("SELECT \"notnull\" value FROM pragma_table_info('journal_entries') WHERE name='body'").get().value, 1);
  database.exec([...schemaSql.CREATE_JOURNAL_MEDIA_SQL, ...schemaSql.MAKE_JOURNAL_BODY_NULLABLE_SQL].join(";\n"));

  assert.equal(database.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name='journal_media'").get().count, 1);
  assert.equal(database.prepare("SELECT \"notnull\" value FROM pragma_table_info('journal_entries') WHERE name='body'").get().value, 0);
  assert.equal(database.prepare("SELECT body FROM journal_entries WHERE id='legacy'").get().body, "Текст");
  database.close();
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
  assert.match(r2, /new FixedLengthStream\(options\.expectedSizeBytes\)/);
  assert.match(r2, /expectedSizeBytes: options\.sizeBytes/);
  assert.match(r2, /controller\.error\(new ApiError\(413/);
  // Любая ошибка записи убирает начатый объект, чтобы не оставлять мусор.
  assert.match(r2, /await deleteObjectQuiet\(bucket, key\)/);
  // cloudflare:workers читается лениво — статический импорт ломал бы сборку.
  assert.match(r2, /await import\("cloudflare:workers"\)/);
  assert.doesNotMatch(r2, /^import .* from "cloudflare:workers"/m);
});

test("storage health reports a missing R2 binding and media routes require it", async () => {
  const health = await readSource("lib/storage-health.ts");
  assert.match(health, /await getMediaBucket\(\)/);
  assert.match(health, /mediaBinding = false/);
  assert.match(health, /ready: d1\.databaseBinding[\s\S]*&& mediaBinding/);
  const session = await readSource("lib/journal-media-upload.ts");
  assert.match(session, /await ensureMediaStorageReady\(\)/);
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

test("client uploads main media and audio track as separate retryable chunks", async () => {
  const api = await readSource("lib/planner-api.ts");
  assert.doesNotMatch(api, /new FormData\(\)|XMLHttpRequest/);
  assert.match(api, /uploadBlobParts\(config, session, "main", input\.file/);
  assert.match(api, /uploadBlobParts\(config, session, "track", input\.audioTrack/);
  assert.match(api, /retryMediaOperation/);
  assert.match(api, /abortMediaUpload\(config, session\.id\)/);
  assert.match(api, /audioTrackBytes: input\.audioTrack\?\.size/);
  // Ссылка на байты запрашивается отдельно и живёт ограниченное время.
  assert.match(api, /file-url/);

  const screen = await readSource("app/secondary-screens.tsx");
  // В запись попадают только серверные метаданные, а не блобы черновиков.
  assert.match(screen, /drafts\.map\(\(draft\) => draft\.server\)/);
});

test("large files are split below the single-request limit and retry only the failed chunk", async () => {
  const upload = await importPureTypeScript("lib/media-upload.ts");
  const total = upload.MEDIA_UPLOAD_CHUNK_SIZE_BYTES * 4 + 123;
  assert.equal(upload.mediaChunkCount(total), 5);
  for (let part = 0; part < upload.mediaChunkCount(total); part += 1) {
    assert.ok(upload.mediaChunkBounds(total, part).size <= 512 * 1024);
  }

  let calls = 0;
  const result = await upload.retryMediaOperation(async () => {
    calls += 1;
    if (calls < 3) throw new Error("temporary");
    return "ok";
  }, { attempts: 3, baseDelayMs: 0 });
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("chunk streams assemble in order without buffering the full file", async () => {
  const upload = await importPureTypeScript("lib/media-upload.ts");
  const parts = [new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5])];
  const stream = upload.concatenateMediaStreams(parts.length, async (part) => new ReadableStream({
    start(controller) {
      controller.enqueue(parts[part]);
      controller.close();
    },
  }));
  assert.deepEqual(new Uint8Array(await new Response(stream).arrayBuffer()), new Uint8Array([1, 2, 3, 4, 5]));
});

test("abort cleans temporary R2 objects and metadata is persisted only after assembly", async () => {
  const service = await readSource("lib/journal-media-upload.ts");
  const abortBlock = service.slice(service.indexOf("export async function abortJournalMediaUpload"));
  assert.match(abortBlock, /deleteR2Objects\(allTemporaryKeys\(manifest\)\)/);

  const completeBlock = service.slice(
    service.indexOf("export async function completeJournalMediaUpload"),
    service.indexOf("export async function abortJournalMediaUpload"),
  );
  const assembly = completeBlock.indexOf("putConcatenatedR2Objects");
  const metadata = completeBlock.indexOf("persistUploadedJournalMedia");
  assert.ok(assembly !== -1 && metadata !== -1 && assembly < metadata);
  assert.match(completeBlock, /Временные чанки остаются до abort\/retry/);
});

test("backup builder never receives tokens or secrets", async () => {
  const backup = await readSource("lib/journal-export.ts");
  assert.doesNotMatch(backup, /token/i);
  assert.doesNotMatch(backup, /apiKey|api_key|secret/i);
  assert.match(backup, /buildBackupManifest/);
  assert.match(backup, /journal\/manifest\.json/);
  assert.match(backup, /journal\/media\/\$\{entry\.id\}\/\$\{mediaFileName\(media\)\}/);
});
