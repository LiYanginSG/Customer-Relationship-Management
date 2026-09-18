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
import {
  sendMessage, sendTyping, esc,
  type TelegramUpdate, type TelegramMessage,
} from "../_shared/telegram.ts";
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
on file. Attach a product PDF — with a caption naming it, like
<code>AIA Max VitalHealth A</code> — and I'll index it for searching.

<b>Commands</b>
/brief — today's briefing, on demand
/week — the week ahead
/due — premiums due and overdue
/birthdays — the next fortnight
/quiet — who's gone cold
/spend — what the AI has cost today
/status — what's switched on
/library — what product documents are uploaded
/forget &lt;name&gt; — remove a document
/product &lt;terms&gt; — search the contracts, free, no AI needed
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

    case "/library": {
      const { data, error } = await db()
        .from("products")
        .select("insurer, name, doc_type, page_count, status, ingested_at")
        .eq("status", "current")
        .order("insurer")
        .order("name");

      if (error) {
        await sendMessage(chatId, `Could not read the library: ${esc(error.message)}`);
        return true;
      }
      if (!data || data.length === 0) {
        await sendMessage(
          chatId,
          "The library is empty.\n\nSend me a product PDF with a caption naming it, " +
          "like <code>AIA Max VitalHealth A</code>, and I'll index it.",
        );
        return true;
      }

      const byInsurer = new Map<string, string[]>();
      for (const d of data) {
        const line = `  • ${esc(String(d.name))}` +
          (d.page_count ? ` <i>(${d.page_count}p)</i>` : "");
        const key = String(d.insurer);
        byInsurer.set(key, [...(byInsurer.get(key) ?? []), line]);
      }

      const blocks = [...byInsurer.entries()]
        .map(([insurer, lines]) => `<b>${esc(insurer)}</b>\n${lines.join("\n")}`);

      await sendMessage(
        chatId,
        `📚 <b>Product library</b> · ${data.length} document(s)\n\n${blocks.join("\n\n")}\n\n` +
        `<i>Search it with</i> <code>/product deferment period</code>`,
      );
      return true;
    }

    case "/product": {
      // Deliberately free. This runs the same full-text search the product desk
      // uses, but returns the passages verbatim instead of having a model
      // summarise them. No API key, no cost -- and for a question about an
      // exclusion or a waiting period, the exact wording is what you want
      // anyway, because that is what you would have to quote to a client.
      const query = args.trim();
      if (!query) {
        await sendMessage(
          chatId,
          "What should I look for?\n\n" +
          "<code>/product deferment period</code>\n" +
          "<code>/product pre-existing exclusion</code>\n\n" +
          "<i>Insurance wording is precise, so exact terms work best.</i>",
        );
        return true;
      }

      const { data, error } = await db().rpc("search_products", {
        query_text: query,
        insurer_filter: null,
        max_results: 4,
      });

      if (error) {
        await sendMessage(chatId, `Search failed: ${esc(error.message)}`);
        return true;
      }
      if (!data || data.length === 0) {
        await sendMessage(
          chatId,
          `Nothing in the library matches <b>${esc(query)}</b>.\n\n` +
          `<i>Check what is uploaded with</i> /library`,
        );
        return true;
      }

      const blocks = data.map((r: Record<string, unknown>) => {
        const body = String(r.content).replace(/\s+/g, " ").trim();
        // Telegram caps a message, and four long clauses will not fit. Trim
        // each rather than lose the later results entirely.
        const excerpt = body.length > 700 ? `${body.slice(0, 700)}…` : body;
        const where = [
          r.insurer, r.product_name,
          r.page_from ? `p${r.page_from}` : null,
        ].filter(Boolean).join(" · ");
        const loose = r.match_type === "partial"
          ? " <i>(loose match — read carefully)</i>"
          : "";
        return `<b>${esc(String(r.heading ?? "Extract"))}</b>${loose}\n` +
               `<i>${esc(where)}</i>\n${esc(excerpt)}`;
      });

      await sendMessage(
        chatId,
        `🔍 <b>${esc(query)}</b>\n\n${blocks.join("\n\n")}\n\n` +
        `<i>Quoted from the documents, not summarised. Verify against the contract ` +
        `before repeating to a client.</i>`,
      );
      return true;
    }

    case "/forget": {
      // Deleting a document is destructive and there is no undo, so this is
      // two steps: name it, see what matched, then confirm with the reference.
      const term = args.trim();
      if (!term) {
        await sendMessage(
          chatId,
          "Which document?\n\n<code>/forget vitalhealth</code>\n\n" +
          "I'll show you what matches before anything is removed. " +
          "See everything with /library.",
        );
        return true;
      }

      // A confirmation looks like: /forget confirm 3f9c1a02
      const confirmMatch = term.match(/^confirm\s+([0-9a-f-]{6,})$/i);
      if (confirmMatch) {
        const prefix = confirmMatch[1].toLowerCase();
        const { data: candidates } = await db()
          .from("products")
          .select("id, insurer, name, storage_path");

        const target = (candidates ?? []).find((p) =>
          String(p.id).toLowerCase().startsWith(prefix)
        );
        if (!target) {
          await sendMessage(chatId, `No document with reference <code>${esc(prefix)}</code>.`);
          return true;
        }

        // The stored file has to go too, or it lingers invisibly in the bucket.
        if (target.storage_path) {
          const { error } = await db().storage
            .from("products").remove([String(target.storage_path)]);
          if (error) console.error("storage remove failed:", error.message);
        }
        await db().from("products").delete().eq("id", target.id);

        await sendMessage(
          chatId,
          `🗑 Removed <b>${esc(String(target.name))}</b> and everything indexed from it.`,
        );
        return true;
      }

      const { data: matches } = await db()
        .from("products")
        .select("id, insurer, name, doc_type, status")
        .or(`name.ilike.%${term}%,insurer.ilike.%${term}%`)
        .limit(10);

      if (!matches || matches.length === 0) {
        await sendMessage(chatId, `Nothing matches <b>${esc(term)}</b>. Try /library.`);
        return true;
      }

      const lines = matches.map((m) =>
        `• <b>${esc(String(m.name))}</b> <i>(${esc(String(m.insurer))})</i>\n` +
        `   <code>/forget confirm ${String(m.id).slice(0, 8)}</code>`
      );

      await sendMessage(
        chatId,
        `Found ${matches.length}:\n\n${lines.join("\n\n")}\n\n` +
        `<i>Deleting removes the file and everything indexed from it. There is no undo. ` +
        `If you only want it out of search results, mark it superseded in the portal instead ` +
        `— that keeps the document but stops it surfacing as current.</i>`,
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
