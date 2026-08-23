export const dynamic = "force-dynamic";

// Выдаёт короткоживущую подписанную ссылку на файл медиа.
// Нужна для <audio>/<video> и скачивания оригиналов при экспорте:
// сами теги не умеют слать Authorization-заголовок.
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { journalMedia } from "@/db/schema";
import { ApiError, jsonOk, readIdParam, withApi } from "@/lib/api";
import { MEDIA_SIGNATURE_TTL_MS, createMediaToken } from "@/lib/media-sign";

export const GET = withApi(async (_request, context) => {
  const id = await readIdParam(context);
  const db = await getDb();
  const rows = await db.select({ id: journalMedia.id }).from(journalMedia).where(eq(journalMedia.id, id)).limit(1);
  if (!rows.length) throw new ApiError(404, "Файл медиа не найден");

  const token = await createMediaToken(id);
  const url = `/api/v1/journal/media/${encodeURIComponent(id)}/file?sig=${encodeURIComponent(token)}`;
  return jsonOk({ url, expiresInMs: MEDIA_SIGNATURE_TTL_MS });
});
