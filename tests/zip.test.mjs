import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// Функциональная проверка минимального ZIP-писателя:
// структура архива читается независимым парсером, данные совпадают побайтово.
const source = await readFile(new URL("../lib/zip.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const zipModule = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);

function parseZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Ищем End Of Central Directory с конца файла.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.notEqual(eocd, -1, "EOCD не найден");
  const entryCount = view.getUint16(eocd + 10, true);
  const centralOffset = view.getUint32(eocd + 16, true);

  const decoder = new TextDecoder();
  const entries = [];
  let cursor = centralOffset;
  for (let i = 0; i < entryCount; i += 1) {
    assert.equal(view.getUint32(cursor, true), 0x02014b50, "сигнатура центральной директории");
    const crc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    entries.push({ name, crc, compressedSize, uncompressedSize, localOffset });
    cursor += 46 + nameLength;
  }

  for (const entry of entries) {
    assert.equal(view.getUint32(entry.localOffset, true), 0x04034b50, "сигнатура локального заголовка");
    const method = view.getUint16(entry.localOffset + 8, true);
    assert.equal(method, 0, "метод хранения — store");
    const localNameLength = view.getUint16(entry.localOffset + 26, true);
    const dataStart = entry.localOffset + 30 + localNameLength;
    entry.data = bytes.subarray(dataStart, dataStart + entry.compressedSize);
  }
  return entries;
}

test("crc32 matches the standard check value", () => {
  const bytes = new TextEncoder().encode("123456789");
  assert.equal(zipModule.crc32(bytes), 0xcbf43926);
  assert.equal(zipModule.crc32(new Uint8Array(0)), 0);
});

test("buildZip produces an archive that round-trips names, sizes and bytes", () => {
  const encoder = new TextEncoder();
  const entries = [
    { name: "journal/manifest.json", data: encoder.encode('{"app":"workazy"}') },
    { name: "journal/entries/entry-1.md", data: encoder.encode("# Запись\n\nПривет, дневник.") },
    { name: "journal/media/entry-1/media-1.webm", data: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 255, 7]) },
  ];
  const archive = zipModule.buildZip(entries);
  const parsed = parseZip(archive);

  assert.equal(parsed.length, entries.length);
  for (let i = 0; i < entries.length; i += 1) {
    assert.equal(parsed[i].name, entries[i].name);
    assert.equal(parsed[i].uncompressedSize, entries[i].data.length);
    assert.equal(parsed[i].compressedSize, entries[i].data.length);
    assert.equal(parsed[i].crc, zipModule.crc32(entries[i].data));
    assert.deepEqual(Array.from(parsed[i].data), Array.from(entries[i].data));
  }
});

test("buildZip handles an empty archive", () => {
  const archive = zipModule.buildZip([]);
  const parsed = parseZip(archive);
  assert.equal(parsed.length, 0);
});
