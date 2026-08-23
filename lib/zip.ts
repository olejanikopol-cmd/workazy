// Минимальный ZIP-писатель без зависимостей: метод store (без сжатия).
// Достаточно для бэкапа дневника: структура валидна для стандартных
// распаковщиков, имена в ASCII/UTF-8, данные идут как есть.
export type ZipInputEntry = { name: string; data: Uint8Array };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: day };
}

export function buildZip(entries: ZipInputEntry[], now: Date = new Date()): Uint8Array {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(now);

  type PreparedEntry = { nameBytes: Uint8Array; data: Uint8Array; crc: number; offset: number };
  const prepared: PreparedEntry[] = [];
  let localSize = 0;
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    prepared.push({ nameBytes, data: entry.data, crc, offset: localSize });
    localSize += 30 + nameBytes.length + entry.data.length;
  }

  const centralSize = prepared.reduce((sum, entry) => sum + 46 + entry.nameBytes.length, 0);
  const totalSize = localSize + centralSize + 22;
  const output = new Uint8Array(totalSize);
  const view = new DataView(output.buffer);

  let position = 0;
  for (const entry of prepared) {
    view.setUint32(position, 0x04034b50, true); // local file header signature
    view.setUint16(position + 4, 20, true); // version needed
    view.setUint16(position + 6, 0, true); // flags
    view.setUint16(position + 8, 0, true); // method: store
    view.setUint16(position + 10, time, true);
    view.setUint16(position + 12, date, true);
    view.setUint32(position + 14, entry.crc, true);
    view.setUint32(position + 18, entry.data.length, true); // compressed size
    view.setUint32(position + 22, entry.data.length, true); // uncompressed size
    view.setUint16(position + 26, entry.nameBytes.length, true);
    view.setUint16(position + 28, 0, true); // extra length
    output.set(entry.nameBytes, position + 30);
    output.set(entry.data, position + 30 + entry.nameBytes.length);
    position += 30 + entry.nameBytes.length + entry.data.length;
  }

  const centralOffset = position;
  for (const entry of prepared) {
    view.setUint32(position, 0x02014b50, true); // central directory signature
    view.setUint16(position + 4, 20, true); // version made by
    view.setUint16(position + 6, 20, true); // version needed
    view.setUint16(position + 8, 0, true); // flags
    view.setUint16(position + 10, 0, true); // method
    view.setUint16(position + 12, time, true);
    view.setUint16(position + 14, date, true);
    view.setUint32(position + 16, entry.crc, true);
    view.setUint32(position + 20, entry.data.length, true);
    view.setUint32(position + 24, entry.data.length, true);
    view.setUint16(position + 28, entry.nameBytes.length, true);
    view.setUint16(position + 30, 0, true); // extra
    view.setUint16(position + 32, 0, true); // comment
    view.setUint16(position + 34, 0, true); // disk start
    view.setUint16(position + 36, 0, true); // internal attrs
    view.setUint32(position + 38, 0, true); // external attrs
    view.setUint32(position + 42, entry.offset, true);
    output.set(entry.nameBytes, position + 46);
    position += 46 + entry.nameBytes.length;
  }

  view.setUint32(position, 0x06054b50, true); // end of central directory
  view.setUint16(position + 4, 0, true);
  view.setUint16(position + 6, 0, true);
  view.setUint16(position + 8, prepared.length, true);
  view.setUint16(position + 10, prepared.length, true);
  view.setUint32(position + 12, centralSize, true);
  view.setUint32(position + 16, centralOffset, true);
  view.setUint16(position + 20, 0, true);

  return output;
}
