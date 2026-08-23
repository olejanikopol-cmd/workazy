export const dynamic = "force-dynamic";

import { jsonOk, withApi } from "@/lib/api";
import { abortJournalMediaUpload, getJournalMediaUploadStatus } from "@/lib/journal-media-upload";

type Params = { id: string };

export const GET = withApi<Params>(async (_request, context) => {
  const { id } = await context.params;
  return jsonOk(await getJournalMediaUploadStatus(id));
});

export const DELETE = withApi<Params>(async (_request, context) => {
  const { id } = await context.params;
  await abortJournalMediaUpload(id);
  return jsonOk({ aborted: true });
});
