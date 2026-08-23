// Groq Speech-to-Text: OpenAI-совместимый формат, но запрос идёт напрямую
// на api.groq.com без официального SDK и без OpenAI API.
// Модель: whisper-large-v3-turbo; язык не задаём — модель сама определяет
// русский или украинский.
import type { TranscriptionProvider } from "./provider";

const GROQ_TRANSCRIPTIONS_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const TRANSCRIPTION_TIMEOUT_MS = 60_000;

export function getGroqTranscriptionProvider(apiKey: string): TranscriptionProvider {
  return {
    name: "groq",
    async transcribe(input) {
      const form = new FormData();
      const blob = new Blob([input.bytes as unknown as BlobPart], { type: input.mimeType || "application/octet-stream" });
      form.append("file", new File([blob], input.filename || "audio", { type: blob.type }));
      form.append("model", "whisper-large-v3-turbo");
      form.append("response_format", "verbose_json");

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TRANSCRIPTION_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(GROQ_TRANSCRIPTIONS_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
          signal: controller.signal,
        });
      } catch (error) {
        const aborted = error instanceof Error && error.name === "AbortError";
        throw new Error(
          aborted
            ? "Сервис расшифровки не ответил вовремя"
            : `Сервис расшифровки недоступен: ${error instanceof Error ? error.message : "неизвестная ошибка"}`,
        );
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Groq вернул статус ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
      }

      const payload = (await response.json()) as {
        text?: string;
        language?: string;
        duration?: number;
      };
      return {
        text: (payload.text ?? "").trim(),
        language: payload.language,
        durationSeconds: typeof payload.duration === "number" ? payload.duration : undefined,
      };
    },
  };
}