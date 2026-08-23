// Доступ к R2-бакету медиа (биндинг MEDIA из .openai/hosting.json).
// Модуль `cloudflare:workers` импортируется лениво — та же конвенция,
// что и в db/index.ts: статический импорт ломал бы сборку в Node.
import { ApiError } from "./api";

export const MEDIA_KEY_PREFIX = "journal-media/";

export async function getMediaBucket(): Promise<R2Bucket> {
  let bucket: R2Bucket | undefined;
  try {
    const { env } = await import("cloudflare:workers");
    bucket = env.MEDIA;
  } catch {
    bucket = undefined;
  }
  if (!bucket) {
    throw new ApiError(503, "Хранилище медиа не настроено. Добавьте «r2»: «MEDIA» в .openai/hosting.json.");
  }
  return bucket;
}

async function deleteObjectQuiet(bucket: R2Bucket, key: string): Promise<void> {
  try {
    await bucket.delete(key);
  } catch {
    // best effort: объект останется недостижимым мусором в приватном бакете
  }
}

// Удаление пользовательских данных подтверждаем только после ответа R2.
// Иначе API сообщил бы об успехе, оставив приватный, но оплачиваемый объект.
export async function deleteR2Objects(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const bucket = await getMediaBucket();
  for (let index = 0; index < keys.length; index += 1000) {
    await bucket.delete(keys.slice(index, index + 1000));
  }
}

// Сохранить поток с защитой от превышения лимита.
// Читаем частями и считаем байты; как только размер превысил лимит —
// обрываем поток и удаляем уже начатый объект, чтобы не оставлять мусор.
// Данные в память не копируются: чанки проходят в R2 как есть.
export async function putStreamLimited(
  bucket: R2Bucket,
  key: string,
  stream: ReadableStream,
  options: {
    maxSizeBytes: number;
    contentType: string;
    customMetadata?: Record<string, string>;
  },
): Promise<{ sizeBytes: number }> {
  let seen = 0;
  let exceeded = false;

  const boundedStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          seen += value.byteLength;
          if (seen > options.maxSizeBytes) {
            exceeded = true;
            controller.error(new ApiError(413, "Файл превышает допустимый размер"));
            return;
          }
          controller.enqueue(value);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
  });

  try {
    await bucket.put(key, boundedStream, {
      httpMetadata: { contentType: options.contentType },
      customMetadata: options.customMetadata,
    });
  } catch (error) {
    // Начатый объект удаляем всегда: и при обрыве, и при ошибке сети.
    await deleteObjectQuiet(bucket, key);
    if (exceeded) throw new ApiError(413, "Файл превышает допустимый размер");
    throw error;
  }

  if (seen === 0) {
    await deleteObjectQuiet(bucket, key);
    throw new ApiError(400, "Файл пустой");
  }

  return { sizeBytes: seen };
}

// Прочитать объект целиком — используется только для ограниченных аудиотреков
// перед транскрипцией (они ограничены лимитом аудио). Оригинальные файлы
// всегда отдаются потоком и в память не читаются.
export async function readR2ObjectBytes(bucket: R2Bucket, key: string): Promise<Uint8Array> {
  const object = await bucket.get(key);
  if (!object) {
    throw new ApiError(410, "Файл медиа не найден в хранилище");
  }
  const buffer = await new Response(object.body).arrayBuffer();
  return new Uint8Array(buffer);
}
