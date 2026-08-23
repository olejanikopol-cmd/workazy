export const dynamic = "force-dynamic";

import { jsonOk, withApi } from "@/lib/api";
import { completeJournalMediaUpload } from "@/lib/journal-media-upload";

type Params = { id: string };

export const POST = withApi<Params>(async (_request, context) => {
  const { id } = await context.params;
  return jsonOk(await completeJournalMediaUpload(id), 201);
});
