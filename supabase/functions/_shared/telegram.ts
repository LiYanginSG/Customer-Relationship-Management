/**
 * telegram.ts -- talking to you.
 *
 * Uses HTML parse mode rather than Markdown. Telegram's MarkdownV2 requires
 * escaping sixteen different characters and silently rejects the whole message
 * if you miss one -- which, with client names containing dots, brackets and
 * hyphens, happens constantly. HTML needs three characters escaped and fails
 * predictably.
 */

import { config } from "./config.ts";
import { scrubNric } from "./nric.ts";

const API = "https://api.telegram.org/bot";

/** Telegram hard-limits a message to 4096 characters. */
const MAX_MESSAGE = 4000;

function api(method: string): string {
  if (!config.telegramToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set");
  }
  return `${API}${config.telegramToken}/${method}`;
}

/** Escape the three characters that matter in Telegram's HTML mode. */
export function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Split a long message on paragraph boundaries where possible, so a briefing
 * never gets cut mid-sentence. Falls back to a hard split only if a single
 * paragraph is itself over the limit.
 */
function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE) return [text];

  const parts: string[] = [];
  let current = "";

  for (const para of text.split("\n\n")) {
    if (para.length > MAX_MESSAGE) {
      if (current) {
        parts.push(current);
        current = "";
      }
      for (let i = 0; i < para.length; i += MAX_MESSAGE) {
        parts.push(para.slice(i, i + MAX_MESSAGE));
      }
      continue;
    }
    if (current.length + para.length + 2 > MAX_MESSAGE) {
      parts.push(current);
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * Send a message. Scrubs NRICs on the way out as a last checkpoint, and splits
 * anything too long for Telegram to accept.
 */
export async function sendMessage(
  chatId: number | string,
  text: string,
  opts: { disablePreview?: boolean } = {},
): Promise<void> {
  const safe = scrubNric(text);

  for (const chunk of splitMessage(safe)) {
    const res = await fetch(api("sendMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: opts.disablePreview ?? true },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      // Telegram rejecting our formatting should not lose the content. Retry
      // once as plain text so you still get the information.
      console.error(`sendMessage failed (${res.status}): ${body}`);
      await fetch(api("sendMessage"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk.replace(/<[^>]+>/g, ""),
        }),
      });
    }
  }
}

/** The "..." indicator, so a slow answer does not look like a dead bot. */
export async function sendTyping(chatId: number | string): Promise<void> {
  try {
    await fetch(api("sendChatAction"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    });
  } catch (e) {
    console.error("sendChatAction failed", e);  // never worth failing a turn over
  }
}

/** Resolve a Telegram file_id to its temporary download URL. */
export async function getFileUrl(fileId: string): Promise<string> {
  const res = await fetch(api("getFile"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
  if (!res.ok) throw new Error(`getFile failed: ${await res.text()}`);

  const json = await res.json() as { ok: boolean; result?: { file_path?: string } };
  const path = json.result?.file_path;
  if (!json.ok || !path) throw new Error("Telegram did not return a file path");

  return `https://api.telegram.org/file/bot${config.telegramToken}/${path}`;
}

/** Download a file Telegram is holding for us. */
export async function downloadFile(fileId: string): Promise<Uint8Array> {
  const url = await getFileUrl(fileId);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`file download failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Shapes of the bits of the Telegram update payload we actually use.
// ---------------------------------------------------------------------------

export interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string; first_name?: string; username?: string };
  from?: { id: number; first_name?: string; username?: string };
  date: number;
  text?: string;
  caption?: string;
  voice?: { file_id: string; duration: number };
  document?: TelegramDocument;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}
