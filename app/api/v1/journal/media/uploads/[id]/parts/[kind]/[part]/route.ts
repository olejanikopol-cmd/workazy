export const dynamic = "force-dynamic";

import { jsonOk, withApi } from "@/lib/api";
import { uploadJournalMediaChunk } from "@/lib/journal-media-upload";

type Params = { id: string; kind: string; part: string };

export const PUT = withApi<Params>(async (request, context) => {
  const { id, kind, part } = await context.params;
  return jsonOk(await uploadJournalMediaChunk(id, kind, part, request));
});
