export const dynamic = "force-dynamic";

// Отдача байтов медиафайла для <audio>/<video>.
// Браузерные плееры не умеют слать Authorization-заголовок, поэтому роут
// принимает либо короткоживущую подпись ?sig=..., либо обычный Bearer.
// Поддерживает HTTP Range — без этого плееры не перематывают.
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { journalMedia } from "@/db/schema";
import { ApiError, jsonError, readIdParam, requireApiToken } from "@/lib/api";
import { extensionForMime } from "@/lib/media-limits";
import { verifyMediaToken } from "@/lib/media-sign";
import { getMediaBucket } from "@/lib/r2";

function parseRangeHeader(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, startText, endText] = match;
  if (!startText && !endText) return null;
  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    const length = Math.min(suffix, size);
    return { start: size - length, end: size - 1 };
  }
  const start = Number(startText);
  if (!Number.isFinite(start) || start >= size) return null;
  const end = endText ? Math.min(Number(endText), size - 1) : size - 1;
  if (!Number.isFinite(end) || end < start) return null;
  return { start, end };
}

export async function GET(request: Request, context: { params: Promise<unknown> }): Promise<Response> {
  try {
    const id = await readIdParam(context);
    const url = new URL(request.url);
    const sig = url.searchParams.get("sig");

    let authorized = false;
    if (sig) {
      authorized = await verifyMediaToken(id, sig);
    } else {
      authorized = (await requireApiToken(request)) === null;
    }
    if (!authorized) return jsonError(401, "Требуется авторизация");

    const db = await getDb();
    const rows = await db.select().from(journalMedia).where(eq(journalMedia.id, id)).limit(1);
    if (!rows.length) return jsonError(404, "Файл медиа не найден");
    const row = rows[0];

    const bucket = await getMediaBucket();
    const size = row.sizeBytes;
    const rangeHeader = request.headers.get("range");

    let object: R2ObjectBody | null;
    let status = 200;
    let contentRange: string | undefined;
    let contentLength = size;

    if (rangeHeader) {
      const range = parseRangeHeader(rangeHeader, size);
      if (!range) {
        return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      }
      object = await bucket.get(row.storageKey, { range: { offset: range.start, length: range.end - range.start + 1 } });
      status = 206;
      contentRange = `bytes ${range.start}-${range.end}/${size}`;
      contentLength = range.end - range.start + 1;
    } else {
      object = await bucket.get(row.storageKey);
    }
    if (!object) return jsonError(410, "Файл медиа не найден в хранилище");

    const fileName = `${row.id}.${extensionForMime(row.mimeType)}`;
    const headers = new Headers({
      "Content-Type": row.mimeType || "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Content-Length": String(contentLength),
      "Content-Disposition": `inline; filename="${fileName}"`,
      // Не позволяем браузерному кэшу пережить срок подписанной ссылки.
      "Cache-Control": "private, no-store",
    });
    if (contentRange) headers.set("Content-Range", contentRange);

    return new Response(object.body, { status, headers });
  } catch (error) {
    if (error instanceof ApiError) return jsonError(error.status, error.message);
    console.error(error);
    return jsonError(500, "Внутренняя ошибка сервера");
  }
}
