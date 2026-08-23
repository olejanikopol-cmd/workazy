import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// Общие лимиты медиа: клиент и сервер должны опираться на одни значения,
// чтобы проверка до отправки совпадала с проверкой при сохранении.
const source = await readFile(new URL("../lib/media-limits.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const limits = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);

test("audio and video limits match the approved plan", () => {
  assert.equal(limits.MAX_AUDIO_DURATION_MS, 15 * 60_000);
  assert.equal(limits.MAX_VIDEO_DURATION_MS, 10 * 60_000);
  assert.equal(limits.MAX_AUDIO_SIZE_BYTES, 24 * 1024 * 1024);
  assert.equal(limits.MAX_VIDEO_SIZE_BYTES, 80 * 1024 * 1024);
  const tenMinuteEstimate = ((limits.VIDEO_BITS_PER_SECOND + limits.AUDIO_BITS_PER_SECOND) * 10 * 60) / 8;
  assert.ok(tenMinuteEstimate < limits.MAX_VIDEO_SIZE_BYTES, "10-минутное видео помещается в серверный лимит");
});

test("normalizeMime strips parameters and lowercases", () => {
  assert.equal(limits.normalizeMime("Audio/WEBM;codecs=opus"), "audio/webm");
  assert.equal(limits.normalizeMime(" video/mp4 "), "video/mp4");
});

test("extensionForMime keeps the recorded format without renaming", () => {
  assert.equal(limits.extensionForMime("audio/webm"), "webm");
  assert.equal(limits.extensionForMime("audio/mp4"), "m4a");
  assert.equal(limits.extensionForMime("video/webm;codecs=vp9"), "webm");
  assert.equal(limits.extensionForMime("video/mp4"), "mp4");
  assert.equal(limits.extensionForMime("application/unknown"), "bin");
});

test("formatDuration renders minutes and seconds", () => {
  assert.equal(limits.formatDuration(0), "");
  assert.equal(limits.formatDuration(undefined), "");
  assert.equal(limits.formatDuration(61_000), "1:01");
  assert.equal(limits.formatDuration(15 * 60_000), "15:00");
});

test("media MIME must match a known container signature", () => {
  assert.equal(limits.mediaHeaderMatchesMime("audio/webm", Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3)), true);
  assert.equal(limits.mediaHeaderMatchesMime("video/mp4", Uint8Array.of(0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70)), true);
  assert.equal(limits.mediaHeaderMatchesMime("audio/ogg", new TextEncoder().encode("OggS")), true);
  assert.equal(limits.mediaHeaderMatchesMime("audio/wav", new TextEncoder().encode("RIFF0000WAVE")), true);
  assert.equal(limits.mediaHeaderMatchesMime("audio/mpeg", new TextEncoder().encode("ID3")), true);
  assert.equal(limits.mediaHeaderMatchesMime("video/mp4", new TextEncoder().encode("not a video")), false);
  assert.equal(limits.mediaHeaderMatchesMime("application/octet-stream", Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3)), false);
});
