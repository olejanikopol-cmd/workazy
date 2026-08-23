// Запросы по 512 KiB проходят отдельно, поэтому общий размер видео больше
// не зависит от лимита одного request на Sites/proxy.
export const MEDIA_UPLOAD_CHUNK_SIZE_BYTES = 512 * 1024;
export const MEDIA_UPLOAD_MAX_ATTEMPTS = 3;

export function mediaChunkCount(sizeBytes: number, chunkSize = MEDIA_UPLOAD_CHUNK_SIZE_BYTES): number {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) throw new Error("Некорректный размер файла");
  return Math.ceil(sizeBytes / chunkSize);
}

export function mediaChunkBounds(
  sizeBytes: number,
  part: number,
  chunkSize = MEDIA_UPLOAD_CHUNK_SIZE_BYTES,
): { start: number; end: number; size: number } {
  const count = mediaChunkCount(sizeBytes, chunkSize);
  if (!Number.isInteger(part) || part < 0 || part >= count) throw new Error("Некорректный номер чанка");
  const start = part * chunkSize;
  const end = Math.min(sizeBytes, start + chunkSize);
  return { start, end, size: end - start };
}

function abortError(): Error {
  return new Error("Загрузка отменена");
}

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(abortError());
    }, { once: true });
  });
}

export async function retryMediaOperation<T>(
  operation: (attempt: number) => Promise<T>,
  options: {
    attempts?: number;
    baseDelayMs?: number;
    signal?: AbortSignal;
    shouldRetry?: (error: unknown) => boolean;
  } = {},
): Promise<T> {
  const attempts = options.attempts ?? MEDIA_UPLOAD_MAX_ATTEMPTS;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (options.signal?.aborted) throw abortError();
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || options.shouldRetry?.(error) === false) throw error;
      await wait((options.baseDelayMs ?? 200) * attempt, options.signal);
    }
  }
  throw lastError;
}

// Склеивает объекты последовательно с backpressure. В памяти находится только
// текущий кусок R2, а не полное видео.
export function concatenateMediaStreams(
  count: number,
  load: (part: number) => Promise<ReadableStream<Uint8Array>>,
): ReadableStream<Uint8Array> {
  let part = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          if (!reader && part < count) reader = (await load(part)).getReader();
          if (!reader) {
            controller.close();
            return;
          }
          const result = await reader.read();
          if (result.done) {
            reader.releaseLock();
            reader = null;
            part += 1;
            continue;
          }
          controller.enqueue(result.value);
          return;
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader?.cancel(reason);
    },
  });
}
