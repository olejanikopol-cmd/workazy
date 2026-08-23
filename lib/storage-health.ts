import { getD1Binding } from "@/db";
import { ApiError } from "./api";
import { getMediaBucket } from "./r2";
import { CREATE_JOURNAL_MEDIA_SQL, MAKE_JOURNAL_BODY_NULLABLE_SQL } from "./storage-schema";

export type StorageHealth = {
  databaseBinding: boolean;
  journalEntriesTable: boolean;
  journalMediaTable: boolean;
  journalBodyNullable: boolean;
  mediaBinding: boolean;
  ready: boolean;
};

type D1SchemaHealth = Omit<StorageHealth, "mediaBinding" | "ready">;

async function inspectD1Schema(): Promise<D1SchemaHealth> {
  let binding: D1Database;
  try {
    binding = await getD1Binding();
  } catch {
    return {
      databaseBinding: false,
      journalEntriesTable: false,
      journalMediaTable: false,
      journalBodyNullable: false,
    };
  }

  const journalEntriesRow = await binding
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'journal_entries'")
    .first<{ name: string }>();
  const journalMediaRow = await binding
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'journal_media'")
    .first<{ name: string }>();
  const bodyColumn = journalEntriesRow
    ? await binding
      .prepare("SELECT \"notnull\" AS not_null FROM pragma_table_info('journal_entries') WHERE name = 'body'")
      .first<{ not_null: number }>()
    : null;

  return {
    databaseBinding: true,
    journalEntriesTable: Boolean(journalEntriesRow),
    journalMediaTable: Boolean(journalMediaRow),
    journalBodyNullable: bodyColumn?.not_null === 0,
  };
}

export async function inspectStorageHealth(): Promise<StorageHealth> {
  const d1 = await inspectD1Schema();
  let mediaBinding = false;
  try {
    await getMediaBucket();
    mediaBinding = true;
  } catch {
    mediaBinding = false;
  }
  return {
    ...d1,
    mediaBinding,
    ready: d1.databaseBinding
      && d1.journalEntriesTable
      && d1.journalMediaTable
      && d1.journalBodyNullable
      && mediaBinding,
  };
}

let schemaReadyPromise: Promise<void> | null = null;

async function repairMediaSchema(): Promise<void> {
  const before = await inspectD1Schema();
  if (!before.databaseBinding) {
    throw new ApiError(503, "База данных D1 не подключена");
  }
  if (!before.journalEntriesTable) {
    throw new ApiError(503, "Базовая схема D1 не применена. Нужна migration 0000");
  }
  if (before.journalMediaTable && before.journalBodyNullable) return;

  console.warn("Workazy storage schema is outdated; applying migration 0001 repair", {
    journalMediaTable: before.journalMediaTable,
    journalBodyNullable: before.journalBodyNullable,
  });

  const binding = await getD1Binding();
  const statements = [
    ...(!before.journalMediaTable ? CREATE_JOURNAL_MEDIA_SQL : []),
    ...(!before.journalBodyNullable ? MAKE_JOURNAL_BODY_NULLABLE_SQL : []),
  ].map((query) => binding.prepare(query));
  const results = await binding.batch(statements);
  if (results.some((result) => !result.success)) {
    throw new Error("D1 migration 0001 repair batch failed");
  }

  const after = await inspectD1Schema();
  if (!after.journalMediaTable || !after.journalBodyNullable) {
    throw new Error("D1 migration 0001 repair did not produce the expected schema");
  }
}

export async function ensureMediaStorageReady({ requireMedia = true }: { requireMedia?: boolean } = {}): Promise<void> {
  if (!schemaReadyPromise) {
    schemaReadyPromise = repairMediaSchema().catch((error) => {
      schemaReadyPromise = null;
      throw error;
    });
  }
  await schemaReadyPromise;
  if (requireMedia) await getMediaBucket();
}
