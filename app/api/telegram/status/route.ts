import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { reminderLogs } from "@/db/schema";
import { getTelegramConfig } from "@/lib/telegram";

export async function GET() {
  try {
    await getTelegramConfig();
    const db = await getDb();
    const latest = await db
      .select({ sentAt: reminderLogs.sentAt })
      .from(reminderLogs)
      .where(eq(reminderLogs.status, "sent"))
      .orderBy(desc(reminderLogs.sentAt))
      .limit(1);

    return Response.json(
      { configured: true, lastSentAt: latest[0]?.sentAt ?? null },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json(
      { configured: false, lastSentAt: null },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
