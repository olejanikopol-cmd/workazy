export const dynamic = "force-dynamic";

// Список медиа-вложений записи дневника (метаданные + транскрипты).
import { getDb } from "@/db";
import { jsonOk, readIdParam, withApi } from "@/lib/api";
import { listMediaByEntry, requireEntryExists } from "@/lib/journal-media";

export const GET = withApi(async (_request, context) => {
  const id = await readIdParam(context);
  const db = await getDb();
  await requireEntryExists(db, id);
  return jsonOk(await listMediaByEntry(db, id));
});
