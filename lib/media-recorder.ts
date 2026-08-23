// Хелперы записи голоса и видео: выбор поддерживаемого MIME,
// обёртка над MediaRecorder с паузой и точным таймером, переключение
// камеры и человекочитаемые сообщения об ошибках доступа.
import { AUDIO_BITS_PER_SECOND, VIDEO_BITS_PER_SECOND } from "./media-limits";

export const AUDIO_RECORDER_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/mpeg",
];

export const VIDEO_RECORDER_MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4",
];

export function recorderIsSupported(): boolean {
  return typeof window !== "undefined" && typeof MediaRecorder !== "undefined";
}

export function pickRecorderMimeType(candidates: string[]): string | undefined {
  if (!recorderIsSupported()) return undefined;
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

export type RecordedResult = { blob: Blob; mimeType: string; durationMs: number };

export type MediaRecorderHandle = {
  mimeType: string;
  canPause: boolean;
  pause(): void;
  resume(): void;
  // null — запись была отменена (данные не нужны).
  stop(): Promise<RecordedResult | null>;
  cancel(): void;
};

// Держим паузы честно: накапливаем уже записанное время и продолжаем
// считать только после resume. Таймер интерфейса опирается на этот же счётчик.
export function startMediaRecorder(stream: MediaStream, kind: "audio" | "video", mimeType?: string): MediaRecorderHandle {
  const options: MediaRecorderOptions = { audioBitsPerSecond: AUDIO_BITS_PER_SECOND };
  if (mimeType) options.mimeType = mimeType;
  if (kind === "video") options.videoBitsPerSecond = VIDEO_BITS_PER_SECOND;

  const recorder = new MediaRecorder(stream, options);
  const chunks: Blob[] = [];
  let elapsedMs = 0;
  let segmentStartedAt: number | null = null;
  let cancelled = false;
  let failed = false;
  let settle: ((value: RecordedResult | null) => void) | null = null;

  const fallbackType = kind === "video" ? "video/webm" : "audio/webm";
  const resultType = recorder.mimeType || mimeType || fallbackType;

  const currentDuration = () => elapsedMs + (segmentStartedAt ? Date.now() - segmentStartedAt : 0);

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  });
  recorder.addEventListener("stop", () => {
    const durationMs = currentDuration();
    segmentStartedAt = null;
    elapsedMs = durationMs;
    if (cancelled || failed) {
      settle?.(null);
      return;
    }
    settle?.({ blob: new Blob(chunks, { type: resultType }), mimeType: resultType, durationMs });
  });
  recorder.addEventListener("error", () => {
    failed = true;
    settle?.(null);
  });

  // Чанки раз в секунду: остановка быстрее и поток не копится в одном куске.
  recorder.start(1000);
  segmentStartedAt = Date.now();

  return {
    mimeType: resultType,
    canPause: typeof recorder.pause === "function",
    pause() {
      if (recorder.state !== "recording") return;
      recorder.pause();
      if (segmentStartedAt) {
        elapsedMs += Date.now() - segmentStartedAt;
        segmentStartedAt = null;
      }
    },
    resume() {
      if (recorder.state !== "paused") return;
      recorder.resume();
      segmentStartedAt = Date.now();
    },
    stop() {
      return new Promise((resolve) => {
        if (recorder.state === "inactive") {
          resolve(cancelled || failed ? null : { blob: new Blob(chunks, { type: resultType }), mimeType: resultType, durationMs: currentDuration() });
          return;
        }
        settle = resolve;
        recorder.stop();
      });
    },
    cancel() {
      cancelled = true;
      try {
        recorder.stop();
      } catch {
        settle?.(null);
      }
    },
  };
}

export function stopStreamTracks(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

// Небольшой хак: прикладной поток (микрофон или камера) и поток для
// транскрипции видео создаются из одних и тех же треков.
export function cloneStream(stream: MediaStream): MediaStream {
  return new MediaStream(stream.getTracks().map((track) => track.clone()));
}

// Переключение фронтальная/задняя камера без перезапуска записи.
// Возвращает false, если устройство не смогло переключиться.
export async function switchCameraFacing(track: MediaStreamTrack, facing: "user" | "environment"): Promise<boolean> {
  try {
    await track.applyConstraints({ facingMode: { ideal: facing } });
    return true;
  } catch {
    return false;
  }
}

export function mediaAccessMessage(error: unknown, kind: "audio" | "video"): string {
  const device = kind === "audio" ? "микрофону" : "камере";
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return `Доступ к ${device} запрещён. Разреши доступ в настройках браузера и попробуй ещё раз.`;
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return kind === "audio" ? "Микрофон не найден." : "Камера не найдена.";
  }
  if (name === "NotReadableError") {
    return `Устройство занято другим приложением. Закрой его и попробуй ещё раз.`;
  }
  return `Не удалось начать запись. Проверь доступ к ${device} и попробуй ещё раз.`;
}
