// Короткоживущие подписанные ссылки на файлы медиа.
// Ключ — существующий WORKAZY_API_TOKEN, сам токен в URL не попадает.
//
// Формат: <exp>.<base64url(hmacSha256(`${mediaId}:${exp}`))>
// Провайдер передаёт подписи как ?sig=<exp>.<hash>.
import { ApiError, getExpectedApiToken } from "./api";

export const MEDIA_SIGNATURE_TTL_MS = 5 * 60_000;

async function getSigningSecret(): Promise<string> {
  const secret = await getExpectedApiToken();
  if (!secret) {
    throw new ApiError(503, "WORKAZY_API_TOKEN не настроен");
  }
  return secret;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Некорректная подпись");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < left.byteLength; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

async function hmacKey(): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(await getSigningSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function sign(mediaId: string, expiresAtMs: number): Promise<string> {
  const encoder = new TextEncoder();
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(),
    encoder.encode(`${mediaId}:${expiresAtMs}`),
  );
  return base64UrlEncode(new Uint8Array(signature));
}

export async function createMediaToken(mediaId: string, nowMs = Date.now()): Promise<string> {
  const expiresAtMs = nowMs + MEDIA_SIGNATURE_TTL_MS;
  return `${expiresAtMs}.${await sign(mediaId, expiresAtMs)}`;
}

export async function verifyMediaToken(mediaId: string, sig: string, nowMs = Date.now()): Promise<boolean> {
  const dot = sig.indexOf(".");
  if (dot <= 0) return false;
  const expiresPart = sig.slice(0, dot);
  const hashPart = sig.slice(dot + 1);
  const expiresAtMs = Number(expiresPart);
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs || expiresAtMs > nowMs + MEDIA_SIGNATURE_TTL_MS) return false;

  try {
    const encoder = new TextEncoder();
    const expected = base64UrlDecode(hashPart);
    const actual = new Uint8Array(
      await crypto.subtle.sign("HMAC", await hmacKey(), encoder.encode(`${mediaId}:${expiresAtMs}`)),
    );
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
