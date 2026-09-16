/**
 * briefing -- the scheduled push.
 *
 * Called by pg_cron on a timer (see migration 0008). Builds the briefing from
 * plain SQL and sends it to Telegram. No API key required, so this keeps
 * working whether or not the AI side is switched on.
 */

import { config, isAllowedChat } from "../_shared/config.ts";
import { sendMessage } from "../_shared/telegram.ts";
import { buildBriefingText, type BriefingKind } from "../_shared/briefing.ts";

const VALID_KINDS: BriefingKind[] = ["morning", "week_ahead", "export_reminder"];

Deno.serve(async (req: Request) => {
  // --- Authenticate -------------------------------------------------------
  // This endpoint is reachable from the open internet, and it messages your
  // phone. The shared secret is what stops anyone else triggering it.
  const provided = req.headers.get("x-cron-secret");
  if (!config.cronSecret || provided !== config.cronSecret) {
    console.warn("briefing: rejected call with bad or missing cron secret");
    return new Response("Forbidden", { status: 403 });
  }

  let kind: BriefingKind = "morning";
  try {
    const body = await req.json() as { kind?: string };
    if (body.kind && VALID_KINDS.includes(body.kind as BriefingKind)) {
      kind = body.kind as BriefingKind;
    }
  } catch {
    // No body, or not JSON. A plain call means the morning briefing.
  }

  if (config.allowedChatIds.length === 0) {
    console.error("briefing: TELEGRAM_ALLOWED_CHAT_IDS is empty, nobody to send to");
    return new Response(
      JSON.stringify({ ok: false, error: "no recipients configured" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  try {
    const text = await buildBriefingText(kind);

    if (!text) {
      // Deliberately silent. See buildBriefingText for why.
      console.log(`briefing(${kind}): nothing worth sending today`);
      return new Response(
        JSON.stringify({ ok: true, sent: false, reason: "nothing to report" }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    let sent = 0;
    for (const chatId of config.allowedChatIds) {
      if (!isAllowedChat(chatId)) continue;
      await sendMessage(chatId, text);
      sent += 1;
    }

    console.log(`briefing(${kind}): sent to ${sent} chat(s)`);
    return new Response(
      JSON.stringify({ ok: true, sent: true, recipients: sent, kind }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`briefing(${kind}) failed:`, message);

    // Tell the adviser the briefing broke rather than leaving a silent gap --
    // a missing briefing is indistinguishable from a quiet day otherwise.
    try {
      for (const chatId of config.allowedChatIds) {
        await sendMessage(
          chatId,
          `⚠️ The morning briefing could not be built.\n\n<code>${message}</code>`,
        );
      }
    } catch (notifyError) {
      console.error("could not report the failure either:", notifyError);
    }

    return new Response(
      JSON.stringify({ ok: false, error: message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
