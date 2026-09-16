/**
 * telegram -- the front door.
 *
 * Telegram POSTs every message here. The rules:
 *   - Answer within a few seconds or Telegram retries, which would double-send.
 *     So: acknowledge immediately, do the real work in the background.
 *   - Verify the secret header. Anyone can guess a function URL.
 *   - Check the chat allowlist. This bot can read an entire client book.
 *
 * Commands work with or without an Anthropic key. Free conversation needs one.
 */

import { config, aiEnabled, isAllowedChat } from "../_shared/config.ts";
import { sendMessage, sendTyping, type TelegramUpdate, type TelegramMessage } from "../_shared/telegram.ts";
import { buildBriefingText } from "../_shared/briefing.ts";
import { handleMessage } from "../_shared/manager.ts";
import { spendToday } from "../_shared/claude.ts";
import { handleDocument, applyImport } from "../_shared/ingest.ts";
import { db } from "../_shared/db.ts";

// Supabase's runtime exposes this for work that should outlive the response.
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

function background(promise: Promise<unknown>): void {
  const task = promise.catch((e) => console.error("background task failed:", e));
  if (typeof EdgeRuntime !== "undefined") {
    EdgeRuntime.waitUntil(task);
  }
}

const HELP = `
I'm your practice manager. Talk to me normally — I'll work out who to ask.

<b>Things to try</b>
"who should I see this week?"
"brief me on Sarah Lim before my 2pm"
"whose birthday is coming up?"
"what's due for payment this month?"
"does the AIA Shield plan cover pre-existing conditions?"

<b>Telling me what happened</b>
Just say it. "Saw Mr Tan today, wife expecting in March, worried about his SA
top-up." I'll file the note, add the family member and set the follow-ups.

<b>Sending me files</b>
Attach your portal export (.csv or .xlsx) and I'll reconcile it against what's
on file. Attach a product PDF and I'll add it to the library.

<b>Commands</b>
/brief — today's briefing, on demand
/week — the week ahead
/due — premiums due and overdue
/birthdays — the next fortnight
/quiet — who's gone cold
/spend — what the AI has cost today
/status — what's switched on
/apply &lt;ref&gt; — confirm a staged spreadsheet import
/id — your Telegram chat ID
`.trim();

// ---------------------------------------------------------------------------
// Commands -- all of these work without an Anthropic key
// ---------------------------------------------------------------------------

async function runCommand(
  chatId: number,
  command: string,
  args: string,
): Promise<boolean> {
  switch (command) {
    case "/start":
    case "/help":
      await sendMessage(chatId, HELP);
      return true;

    case "/brief": {
      const text = await buildBriefingText("morning");
      await sendMessage(chatId, text ?? "Nothing pressing today — no premiums due, no birthdays, nothing overdue.");
      return true;
    }

    case "/week": {
      const text = await buildBriefingText("week_ahead");
      await sendMessage(chatId, text ?? "Quiet week ahead.");
      return true;
    }

    case "/due": {
      const { data } = await db()
        .from("v_premiums_due")
        .select("*")
        .lte("days_away", 30)
        .order("days_away", { ascending: true });

      if (!data || data.length === 0) {
        await sendMessage(chatId, "Nothing due in the next 30 days.");
        return true;
      }
      const lines = data.map((p) => {
        const late = Number(p.days_away) < 0;
        const when = late
          ? `<b>${Math.abs(Number(p.days_away))} days late</b>`
          : `in ${p.days_away} days`;
        return `• ${p.display_name} — ${p.insurer} ${p.plan_name}, $${p.premium_amount} — ${when}`;
      });
      await sendMessage(chatId, `💰 <b>Premiums, next 30 days</b>\n${lines.join("\n")}`);
      return true;
    }

    case "/birthdays": {
      const { data } = await db()
        .from("v_upcoming_birthdays")
        .select("*")
        .gte("days_away", 0)
        .lte("days_away", 14)
        .order("days_away", { ascending: true });

      if (!data || data.length === 0) {
        await sendMessage(chatId, "No birthdays in the next fortnight.");
        return true;
      }
      const lines = data.map((b) =>
        `• ${b.display_name}${b.whose === "family" ? ` (${b.client_name}'s ${b.relationship})` : ""}` +
        ` — turns ${b.turning} ${b.days_away === 0 ? "today" : `in ${b.days_away} days`}`
      );
      await sendMessage(chatId, `🎂 <b>Next fortnight</b>\n${lines.join("\n")}`);
      return true;
    }

    case "/quiet": {
      const { data } = await db()
        .from("v_clients_gone_quiet")
        .select("*")
        .order("days_overdue", { ascending: false })
        .limit(15);

      if (!data || data.length === 0) {
        await sendMessage(chatId, "Nobody's overdue a conversation. Well kept.");
        return true;
      }
      const lines = data.map((c) =>
        `• ${c.display_name} — ${c.days_since_contact == null ? "never contacted" : `${c.days_since_contact} days`}`
      );
      await sendMessage(chatId, `🔵 <b>Gone quiet</b>\n${lines.join("\n")}`);
      return true;
    }

    case "/spend": {
      if (!aiEnabled()) {
        await sendMessage(chatId, "No AI key is set, so nothing is being spent. Everything you see is free.");
        return true;
      }
      const spent = await spendToday();
      const { data } = await db()
        .from("app_settings").select("daily_spend_cap_usd").eq("id", 1).maybeSingle();
      const cap = Number(data?.daily_spend_cap_usd ?? config.dailyCapUsd);
      await sendMessage(
        chatId,
        `Today: <b>US$${spent.toFixed(3)}</b> of a US$${cap.toFixed(2)} cap.\n\n` +
        `<i>Scheduled briefings are free — this only counts conversations.</i>`,
      );
      return true;
    }

    case "/status": {
      const [clients, policies] = await Promise.all([
        db().from("clients").select("id", { count: "exact", head: true }),
        db().from("policies").select("id", { count: "exact", head: true }).eq("status", "in_force"),
      ]);
      await sendMessage(
        chatId,
        `<b>Office status</b>\n` +
        `Clients on file: ${clients.count ?? 0}\n` +
        `Policies in force: ${policies.count ?? 0}\n` +
        `Manager and staff: ${aiEnabled() ? "awake ✅" : "asleep — no API key set"}\n` +
        `Scheduled briefings: always on, always free\n\n` +
        (aiEnabled()
          ? "<i>Talk to me normally.</i>"
          : "<i>Commands work. For conversation, add an ANTHROPIC_API_KEY.</i>"),
      );
      return true;
    }

    case "/apply": {
      const prefix = args.trim().split(/\s+/)[0] ?? "";
      if (!prefix) {
        await sendMessage(
          chatId,
          "Which import? Send <code>/apply</code> followed by the reference I gave you, " +
          "e.g. <code>/apply 3f9c1a02</code>.",
        );
        return true;
      }
      await applyImport(chatId, prefix);
      return true;
    }

    case "/id":
      await sendMessage(chatId, `This chat's ID is <code>${chatId}</code>`);
      return true;

    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

async function process(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;

  // Files: spreadsheet imports and product documents.
  if (message.document) {
    await sendTyping(chatId);
    await handleDocument(chatId, message.document, message.caption);
    return;
  }

  if (message.voice) {
    await sendMessage(
      chatId,
      "I can't listen to voice notes yet — Telegram gives me the audio but " +
      "transcribing it needs a speech service I haven't been given. Type it " +
      "and I'll file it properly.",
    );
    return;
  }

  const text = (message.text ?? message.caption ?? "").trim();
  if (!text) return;

  // Commands first: they are free and always available.
  const parts = text.split(/\s+/);
  const command = parts[0].toLowerCase().replace(/@.*$/, "");
  if (command.startsWith("/")) {
    const handled = await runCommand(chatId, command, parts.slice(1).join(" "));
    if (handled) return;
    await sendMessage(chatId, `I don't know <code>${command}</code>. Try /help.`);
    return;
  }

  // Free conversation needs the AI side switched on.
  if (!aiEnabled()) {
    await sendMessage(
      chatId,
      "I can't hold a conversation yet — that needs an Anthropic API key, " +
      "which isn't set.\n\nEverything scheduled still works, and so do the " +
      "commands: /brief, /due, /birthdays, /quiet. Try /help for the list.",
    );
    return;
  }

  await sendTyping(chatId);

  try {
    const reply = await handleMessage(chatId, text);
    await sendMessage(chatId, reply.text);
    console.log(
      `manager replied to ${chatId}: $${reply.costUsd.toFixed(4)}, ` +
      `desks: ${reply.desksConsulted.join(", ") || "none"}`,
    );
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("manager failed:", detail);
    await sendMessage(
      chatId,
      `Something went wrong on my end.\n\n<code>${detail}</code>\n\n` +
      `The commands still work — try /brief.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("This endpoint expects Telegram webhooks.", { status: 405 });
  }

  // Telegram sends this header if the webhook was registered with a secret.
  if (config.telegramWebhookSecret) {
    const provided = req.headers.get("x-telegram-bot-api-secret-token");
    if (provided !== config.telegramWebhookSecret) {
      console.warn("telegram: rejected call with bad webhook secret");
      return new Response("Forbidden", { status: 403 });
    }
  }

  let update: TelegramUpdate;
  try {
    update = await req.json() as TelegramUpdate;
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const message = update.message ?? update.edited_message;
  if (!message) return new Response("ok");

  const chatId = message.chat.id;

  if (!isAllowedChat(chatId)) {
    // /id is answered even from an unknown chat, because you need your own
    // chat ID in order to fill in the allowlist in the first place. It reveals
    // nothing but the number Telegram already assigned to this conversation.
    const text = (message.text ?? "").trim().toLowerCase();
    if (text.startsWith("/id") || text.startsWith("/start")) {
      background(sendMessage(
        chatId,
        `This chat's ID is <code>${chatId}</code>\n\n` +
        `Add it to <code>TELEGRAM_ALLOWED_CHAT_IDS</code> in your Supabase ` +
        `function secrets, then message me again.`,
      ));
      return new Response("ok");
    }
    console.warn(`telegram: ignored message from chat ${chatId} (not allowlisted)`);
    return new Response("ok");
  }

  // Acknowledge now, work afterwards. Telegram retries anything slower than a
  // few seconds, and a retried webhook means the same question answered twice.
  background(process(message));

  return new Response("ok");
});
