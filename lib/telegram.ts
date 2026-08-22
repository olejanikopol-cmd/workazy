// Клиент Telegram Bot API: только отправка сообщений, без сторонних библиотек
// и без OpenAI API. Секреты TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID берутся
// из окружения воркера (как WORKAZY_API_TOKEN в lib/api.ts).

type TelegramConfig = { token: string; chatId: string };

async function readEnv(name: string): Promise<string | undefined> {
  if (process.env[name]) return process.env[name];
  try {
    const { env } = await import("cloudflare:workers");
    const value = env[name];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function getTelegramConfig(): Promise<TelegramConfig> {
  const token = (await readEnv("TELEGRAM_BOT_TOKEN"))?.trim();
  const chatId = (await readEnv("TELEGRAM_CHAT_ID"))?.trim();
  if (!token) throw new Error("Секрет TELEGRAM_BOT_TOKEN не настроен");
  if (!chatId) throw new Error("Секрет TELEGRAM_CHAT_ID не настроен");
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error("Секрет TELEGRAM_BOT_TOKEN имеет неверный формат");
  if (!/^-?\d+$/.test(chatId)) throw new Error("Секрет TELEGRAM_CHAT_ID имеет неверный формат");
  return { token, chatId };
}

export async function sendTelegramMessage(text: string): Promise<void> {
  const { token, chatId } = await getTelegramConfig();
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  const result = await response.json().catch(() => null) as { ok?: boolean } | null;
  if (!response.ok || result?.ok !== true) {
    throw new Error(`Telegram API вернул ошибку ${response.status}`);
  }
}
