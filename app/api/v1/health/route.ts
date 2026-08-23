export const dynamic = "force-dynamic";

import { ensureMediaStorageReady, inspectStorageHealth } from "@/lib/storage-health";
import { requireApiToken } from "@/lib/api";

export async function GET(request: Request): Promise<Response> {
  const denied = await requireApiToken(request);
  if (denied) return denied;

  let repairError: unknown;
  try {
    // Sites only packages migration files in the build artifact. This guarded,
    // idempotent check also repairs an existing deployment that missed 0001.
    await ensureMediaStorageReady({ requireMedia: false });
  } catch (error) {
    repairError = error;
    console.error("Workazy storage health repair failed", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  const storage = await inspectStorageHealth();
  const status = storage.ready ? 200 : 503;
  return Response.json({
    ok: storage.ready,
    data: {
      status: storage.ready ? "ok" : "degraded",
      storage,
    },
    ...(!storage.ready ? {
      error: repairError
        ? "Хранилище не готово. Проверьте D1 migration 0001 и R2 binding MEDIA"
        : "Хранилище не готово. Проверьте R2 binding MEDIA",
    } : {}),
  }, { status });
}
