export const dynamic = "force-dynamic";

import { jsonOk, readJsonBody, withApi } from "@/lib/api";
import { createJournalMediaUpload } from "@/lib/journal-media-upload";

export const POST = withApi(async (request) => {
  const session = await createJournalMediaUpload(await readJsonBody(request));
  return jsonOk(session, 201);
});
