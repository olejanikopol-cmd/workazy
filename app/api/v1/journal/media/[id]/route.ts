export const dynamic = "force-dynamic";

// Метаданные одного медиа-вложения: просмотр для приложения и ChatGPT,
// правка транскрипта пользователем, удаление файла.
import { ApiError, jsonOk, readIdParam, readJsonBody, readOptionalText, withApi } from "@/lib/api";
import { deleteJournalMedia, getMediaRow, mediaToJson, updateMediaTranscript } from "@/lib/journal-media";

export const GET = withApi(async (_request, context) => {
  const id = await readIdParam(context);
  const row = await getMediaRow(id);
  return jsonOk(mediaToJson(row));
});

export const PATCH = withApi(async (request, context) => {
  const id = await readIdParam(context);
  const body = await readJsonBody(request);
  const transcript = readOptionalText(body.transcript, "transcript", { maxLength: 20000 });
  if (transcript === undefined) throw new ApiError(400, "Поле «transcript» обязательно (строка или пустое значение)");
  return jsonOk(await updateMediaTranscript(id, transcript ?? ""));
});

export const DELETE = withApi(async (_request, context) => {
  const id = await readIdParam(context);
  await deleteJournalMedia(id);
  return jsonOk({ deleted: true });
});
