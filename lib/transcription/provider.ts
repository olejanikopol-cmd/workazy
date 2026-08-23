// Абстракция провайдера расшифровки речи.
// Изначальный провайдер — Groq (Whisper); OpenAI API не используется.
// Для замены провайдера достаточно добавить реализацию и переключить фабрику.
import { ApiError } from "../api";
import { getGroqTranscriptionProvider } from "./groq";

export type TranscriptionInput = {
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
};

export type TranscriptionResult = {
  text: string;
  language?: string;
  durationSeconds?: number;
};

export type TranscriptionProvider = {
  name: string;
  transcribe(input: TranscriptionInput): Promise<TranscriptionResult>;
};

export async function getTranscriptionProvider(): Promise<TranscriptionProvider> {
  const groqKey = process.env.GROQ_API_KEY || "";
  if (groqKey) {
    return getGroqTranscriptionProvider(groqKey);
  }
  throw new ApiError(
    503,
    "Расшифровка недоступна: не настроен GROQ_API_KEY. Файл сохранён — повторите попытку после настройки.",
  );
}