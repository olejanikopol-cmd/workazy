export const dynamic = "force-dynamic";

// Запуск/повтор расшифровки по уже сохранённому файлу.
// Сбой не удаляет медиа: возвращается статус error с текстом и кнопкой повтора.
import { jsonOk, readIdParam, withApi } from "@/lib/api";
import { transcribeJournalMedia } from "@/lib/journal-media";

export const POST = withApi(async (_request, context) => {
  const id = await readIdParam(context);
  const media = await transcribeJournalMedia(id);
  return jsonOk(media);
});
