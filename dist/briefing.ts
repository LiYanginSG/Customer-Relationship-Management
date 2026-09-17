// ---------------------------------------------------------------------------
// briefing.ts -- generated file, do not edit directly.
//
// Built from supabase/functions/briefing/index.ts and everything it imports, flattened
// into one file so it can be pasted straight into the Supabase dashboard's
// Edge Function editor. No terminal required.
//
// Edit the real source under supabase/functions/, then regenerate with:
//     python3 scripts/bundle.py
// ---------------------------------------------------------------------------

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

// ===== _shared/config.ts ===========================================
/**
 * config.ts -- everything the office needs to know about itself.
 *
 * The single most important idea here is `aiEnabled`. This system is designed
 * to run usefully with NO Anthropic API key at all: the scheduled briefings,
 * birthday alerts and premium reminders are plain database queries and cost
 * nothing. Setting ANTHROPIC_API_KEY is what wakes the manager and the staff up.
 *
 * Nothing in this file throws on a missing optional secret. A half-configured
 * deployment should degrade to the free mode, not crash at 7am.
 */

function env(name: string): string | undefined {
  const v = Deno.env.get(name);
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

function requireEnv(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`Missing required secret: ${name}`);
  return v;
}

export const config = {
  // --- Supabase (always required) ---------------------------------------
  supabaseUrl: requireEnv("SUPABASE_URL"),
  serviceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),

  // --- Telegram (required for any messaging at all) ----------------------
  telegramToken: env("TELEGRAM_BOT_TOKEN"),

  /**
   * Only these Telegram chat IDs may talk to the bot. This is the lock on the
   * front door: without it, anyone who discovers your bot's name could ask it
   * about your clients. Comma separated.
   */
  allowedChatIds: (env("TELEGRAM_ALLOWED_CHAT_IDS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  /** Telegram signs webhook calls with this. Set it when registering the webhook. */
  telegramWebhookSecret: env("TELEGRAM_WEBHOOK_SECRET"),

  /** Proves a scheduled call really came from pg_cron and not the open internet. */
  cronSecret: env("CRON_SECRET"),

  // --- Claude (entirely optional) ---------------------------------------
  anthropicKey: env("ANTHROPIC_API_KEY"),

  /**
   * The manager: the one you talk to. Judgement and tone matter most here.
   */
  managerModel: env("MANAGER_MODEL") ?? "claude-opus-5",

  /**
   * The staff: focused lookups inside one domain, with a narrow tool surface.
   * Setting this to claude-sonnet-5 roughly halves the cost of a busy day at
   * some cost in nuance. Your call -- it is a one-line change in the dashboard.
   */
  staffModel: env("STAFF_MODEL") ?? "claude-opus-5",

  /** Hard ceiling. When the day's spend passes this, the AI stops answering. */
  dailyCapUsd: Number(env("DAILY_SPEND_CAP_USD") ?? "1.00"),

  timezone: "Asia/Singapore",
} as const;

/** True when a Claude key is present, i.e. the manager and staff are awake. */
export const aiEnabled = (): boolean => Boolean(config.anthropicKey);

/** True when this chat is allowed to talk to the bot. */
export function isAllowedChat(chatId: number | string): boolean {
  // An empty allowlist means nobody, deliberately. Failing closed is the only
  // safe default for a bot that can read your entire client book.
  if (config.allowedChatIds.length === 0) return false;
  return config.allowedChatIds.includes(String(chatId));
}

// ===== _shared/nric.ts =============================================
/**
 * nric.ts -- the second line of defence on NRIC numbers.
 *
 * The database already scrubs NRICs on write (migration 0002). This module
 * scrubs them on the way OUT of the system too: before any text is sent to
 * Claude, and before any text is sent back to Telegram.
 *
 * Belt and braces is warranted here. An NRIC that reaches a model provider
 * cannot be un-sent, and under PDPA it is exactly the identifier you are
 * expected to be most careful with.
 */

/** Singapore NRIC / FIN: S T F G or M, seven digits, one check letter. */
const NRIC_PATTERN = /\b[STFGMstfgm]\d{7}[A-Za-z]\b/g;

export const NRIC_PLACEHOLDER = "[NRIC-REMOVED]";

/** Replace any NRIC or FIN found in the text. Safe to call on anything. */
export function scrubNric(text: string): string {
  return text.replace(NRIC_PATTERN, NRIC_PLACEHOLDER);
}

/** True if the text contains something shaped like an NRIC. */
export function containsNric(text: string): boolean {
  NRIC_PATTERN.lastIndex = 0;
  return NRIC_PATTERN.test(text);
}

/**
 * Recursively scrub every string in a JSON-shaped value. Used on database rows
 * before they are handed to a model, so a stray NRIC that predates the database
 * trigger still never leaves the building.
 */
export function scrubDeep<T>(value: T): T {
  if (typeof value === "string") return scrubNric(value) as unknown as T;
  if (Array.isArray(value)) return value.map(scrubDeep) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubDeep(v);
    }
    return out as T;
  }
  return value;
}

// ===== _shared/telegram.ts =========================================
/**
 * telegram.ts -- talking to you.
 *
 * Uses HTML parse mode rather than Markdown. Telegram's MarkdownV2 requires
 * escaping sixteen different characters and silently rejects the whole message
 * if you miss one -- which, with client names containing dots, brackets and
 * hyphens, happens constantly. HTML needs three characters escaped and fails
 * predictably.
 */



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

// ===== _shared/db.ts ===============================================
/**
 * db.ts -- the one connection to Supabase, using the service_role key.
 *
 * service_role bypasses Row Level Security. That is correct here (the edge
 * function IS the trusted server), and it is exactly why this key must never
 * be sent to Telegram, logged, or echoed into a model prompt.
 */



// Named distinctly from claude.ts's client so the two survive being
// flattened into one file for dashboard deployment.
let cachedDb: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (!cachedDb) {
    cachedDb = createClient(config.supabaseUrl, config.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return cachedDb;
}

/**
 * Calls a Postgres function and returns its result, with the error surfaced as
 * a thrown Error rather than a silent null -- a briefing that quietly sends an
 * empty message is worse than one that fails loudly.
 */
export async function rpc<T = unknown>(
  fn: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const { data, error } = await db().rpc(fn, args);
  if (error) throw new Error(`rpc ${fn} failed: ${error.message}`);
  return data as T;
}

// ===== _shared/dates.ts ============================================
/**
 * dates.ts -- Singapore time, everywhere.
 *
 * Edge functions run on UTC. Every date a financial adviser cares about --
 * whether a premium is late, whether today is someone's birthday -- is a
 * Singapore date. Getting this wrong by eight hours means a birthday alert
 * arriving the day after the birthday, so it is worth being strict.
 */

const TZ = "Asia/Singapore";

/** Today's date in Singapore, as YYYY-MM-DD. */
export function sgToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ });
}

/** Current Singapore time, e.g. "Tuesday, 16 September 2025, 7:02 am". */
export function sgNow(): string {
  return new Date().toLocaleString("en-SG", {
    timeZone: TZ,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Day of the week in Singapore, e.g. "Tuesday". */
export function sgWeekday(): string {
  return new Date().toLocaleDateString("en-SG", { timeZone: TZ, weekday: "long" });
}

/** Format a date for reading, e.g. "Thu 18 Sep". */
export function formatShort(date: string | Date | null | undefined): string {
  if (!date) return "-";
  const d = typeof date === "string" ? new Date(`${date}T00:00:00+08:00`) : date;
  if (Number.isNaN(d.getTime())) return String(date);
  return d.toLocaleDateString("en-SG", {
    timeZone: TZ,
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/** Turn a day count into something readable: "today", "tomorrow", "in 4 days". */
export function relativeDays(days: number | null | undefined): string {
  if (days == null) return "";
  const n = Number(days);
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n === -1) return "yesterday";
  if (n < 0) return `${Math.abs(n)} days ago`;
  return `in ${n} days`;
}

/** Money, the way you would write it to a client: $1,250 or $1,250.50. */
export function money(amount: number | string | null | undefined): string {
  if (amount == null) return "-";
  const n = Number(amount);
  if (Number.isNaN(n)) return String(amount);
  return `$${n.toLocaleString("en-SG", {
    minimumFractionDigits: n % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

// ===== _shared/briefing.ts =========================================
/**
 * briefing.ts -- the morning message.
 *
 * Everything here is formatted from a single SQL query. No model is called, no
 * API key is needed, and it costs nothing to run. That is deliberate: the part
 * of this system you rely on every single morning should not have a bill or a
 * dependency on anyone's service being up.
 */




// ---------------------------------------------------------------------------
// Shapes returned by build_daily_briefing()
// ---------------------------------------------------------------------------

interface Birthday {
  client_id: string; client_name: string; display_name: string;
  whose: string; relationship: string | null;
  next_birthday: string; days_away: number; turning: number;
  client_status: string; last_contacted_at: string | null;
}

interface PremiumDue {
  client_name: string; display_name: string; insurer: string; plan_name: string;
  premium_amount: number; premium_mode: string; next_premium_due: string;
  days_away: number; paid_from_cpf: boolean;
}

interface Anniversary {
  client_name: string; display_name: string; insurer: string; plan_name: string;
  policy_type: string; sum_assured: number | null; next_anniversary: string;
  days_away: number; years_in_force: number; last_reviewed_at: string | null;
}

interface GoneQuiet {
  client_name: string; display_name: string; days_since_contact: number | null;
  days_overdue: number; policies_in_force: number; total_premium: number | null;
}

interface ActionDue {
  client_name: string | null; display_name: string | null;
  title: string; due_date: string; days_away: number; priority: string;
}

export interface Briefing {
  generated_for: string;
  birthdays: Birthday[];
  premiums_due: PremiumDue[];
  anniversaries: Anniversary[];
  gone_quiet: GoneQuiet[];
  actions_due: ActionDue[];
  counts: {
    clients: number; policies_in_force: number;
    open_actions: number; overdue_actions: number;
  };
}

/**
 * Milestone ages worth a mention. These are the ones that genuinely change
 * someone's planning position in Singapore, not just round numbers.
 */
function milestoneNote(age: number): string | null {
  switch (age) {
    case 18: return "can hold a policy in their own name";
    case 21: return "ages out of most child riders";
    case 25: return "typically the end of education cover";
    case 35: return "premiums step up noticeably from here";
    case 55: return "CPF Retirement Account forms, OA withdrawals open";
    case 62: return "re-employment age";
    case 65: return "CPF LIFE payouts can start";
    case 70: return "many term plans expire around now";
    default:
      return age % 10 === 0 && age >= 30 ? "milestone birthday" : null;
  }
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function birthdaySection(rows: Birthday[]): string | null {
  if (rows.length === 0) return null;

  const lines = rows.map((b) => {
    const when = b.days_away === 0
      ? "<b>today</b>"
      : `${formatShort(b.next_birthday)} (${relativeDays(b.days_away)})`;

    const who = b.whose === "family"
      ? `${esc(b.display_name)} — ${esc(b.client_name)}'s ${esc(b.relationship ?? "family")}`
      : esc(b.display_name);

    const milestone = milestoneNote(b.turning);
    const tail = milestone ? ` — ${esc(milestone)}` : "";

    // Worth knowing if a birthday greeting would be the first contact in ages.
    let cold = "";
    if (b.whose === "client" && b.last_contacted_at) {
      const days = Math.floor(
        (Date.now() - new Date(b.last_contacted_at).getTime()) / 86400000,
      );
      if (days > 120) cold = `\n   <i>no contact in ${days} days</i>`;
    } else if (b.whose === "client" && !b.last_contacted_at) {
      cold = "\n   <i>no contact on record</i>";
    }

    return `• ${who} — turns ${b.turning} ${when}${tail}${cold}`;
  });

  return `🎂 <b>Birthdays</b>\n${lines.join("\n")}`;
}

function premiumSection(rows: PremiumDue[]): string | null {
  if (rows.length === 0) return null;

  const overdue = rows.filter((p) => p.days_away < 0);
  const upcoming = rows.filter((p) => p.days_away >= 0);
  const blocks: string[] = [];

  if (overdue.length > 0) {
    const lines = overdue.map((p) =>
      `• <b>${esc(p.display_name)}</b> — ${esc(p.insurer)} ${esc(p.plan_name)}, ` +
      `${money(p.premium_amount)} — <b>${Math.abs(p.days_away)} days late</b>` +
      (p.paid_from_cpf ? " (CPF-funded — check the account balance)" : "")
    );
    blocks.push(`🔴 <b>Premiums overdue — lapse risk</b>\n${lines.join("\n")}`);
  }

  if (upcoming.length > 0) {
    const lines = upcoming.map((p) =>
      `• ${esc(p.display_name)} — ${esc(p.insurer)} ${esc(p.plan_name)}, ` +
      `${money(p.premium_amount)} ${relativeDays(p.days_away)} ` +
      `(${formatShort(p.next_premium_due)})` +
      (p.paid_from_cpf ? " · CPF" : "")
    );
    blocks.push(`💰 <b>Premiums due</b>\n${lines.join("\n")}`);
  }

  return blocks.join("\n\n");
}

function anniversarySection(rows: Anniversary[]): string | null {
  if (rows.length === 0) return null;

  const lines = rows.map((a) => {
    const never = a.last_reviewed_at == null ? " — <i>never reviewed</i>" : "";
    return `• ${esc(a.display_name)} — ${esc(a.plan_name)} hits year ${a.years_in_force} ` +
      `${relativeDays(a.days_away)}${never}`;
  });

  return `📋 <b>Policy anniversaries</b>\n${lines.join("\n")}`;
}

function quietSection(rows: GoneQuiet[]): string | null {
  if (rows.length === 0) return null;

  const lines = rows.map((c) => {
    const since = c.days_since_contact == null
      ? "no contact on record"
      : `${c.days_since_contact} days quiet`;
    const worth = c.total_premium
      ? `, ${money(c.total_premium)} on the books`
      : "";
    return `• ${esc(c.display_name)} — ${since}${worth}`;
  });

  return `🔵 <b>Gone quiet</b>\n${lines.join("\n")}`;
}

function actionSection(rows: ActionDue[]): string | null {
  if (rows.length === 0) return null;

  const lines = rows.map((a) => {
    const who = a.display_name ? `${esc(a.display_name)}: ` : "";
    const late = a.days_away < 0
      ? ` <b>(${Math.abs(a.days_away)} days overdue)</b>`
      : ` (${relativeDays(a.days_away)})`;
    return `• ${who}${esc(a.title)}${late}`;
  });

  return `✅ <b>You promised</b>\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export type BriefingKind = "morning" | "week_ahead" | "export_reminder";

/**
 * Build the briefing text. Returns null when there is genuinely nothing worth
 * saying -- a bot that sends "nothing today" every day gets muted, and a muted
 * bot is useless on the day something does matter.
 */
export async function buildBriefingText(kind: BriefingKind): Promise<string | null> {
  if (kind === "export_reminder") return formatBriefing(null, kind);

  // Look further ahead on the Sunday planning note than on a weekday morning.
  const horizons = kind === "week_ahead"
    ? { birthday: 9, premium: 14, anniversary: 21, quiet: 8 }
    : { birthday: 7, premium: 10, anniversary: 14, quiet: 5 };

  const data = await rpc<Briefing>("build_daily_briefing", {
    birthday_horizon_days: horizons.birthday,
    premium_horizon_days: horizons.premium,
    anniversary_horizon_days: horizons.anniversary,
    quiet_limit: horizons.quiet,
  });

  return formatBriefing(data, kind);
}

/**
 * Turn briefing data into the message text. Pure -- no database, no clock
 * beyond the date helpers -- so it can be tested against fixed data.
 */
export function formatBriefing(
  data: Briefing | null,
  kind: BriefingKind,
): string | null {
  if (kind === "export_reminder") {
    return (
      `📤 <b>Monthly export</b>\n\n` +
      `Time to pull a fresh export from the company portal and send it here — ` +
      `just attach the file to a message and I'll reconcile it.\n\n` +
      `<i>Do the export yourself rather than automating the login. Those are ` +
      `your principal's credentials, and agency IT rules almost always forbid ` +
      `automated access.</i>`
    );
  }

  if (!data) return null;

  const sections = [
    premiumSection(data.premiums_due),     // money first -- it is the urgent one
    actionSection(data.actions_due),
    birthdaySection(data.birthdays),
    anniversarySection(data.anniversaries),
    quietSection(data.gone_quiet),
  ].filter((s): s is string => s !== null);

  if (sections.length === 0) {
    // Quiet days are real. Say so once a week, not every day.
    return kind === "week_ahead"
      ? `☀️ <b>Week ahead</b>\n\nNothing pressing — no premiums due, no birthdays, ` +
        `no overdue promises. Good week to do some prospecting.`
      : null;
  }

  const heading = kind === "week_ahead"
    ? `☀️ <b>The week ahead</b>`
    : `☀️ <b>Morning briefing</b> · ${formatShort(sgToday())}`;

  const plural = (n: number, one: string, many: string) =>
    `${n} ${n === 1 ? one : many}`;

  const footer =
    `\n\n<i>${plural(data.counts.clients, "client", "clients")} · ` +
    `${plural(data.counts.policies_in_force, "policy", "policies")} in force · ` +
    `${plural(data.counts.open_actions, "open follow-up", "open follow-ups")}</i>`;

  return `${heading}\n\n${sections.join("\n\n")}${footer}`;
}

// ===== briefing/index.ts ===========================================
/**
 * briefing -- the scheduled push.
 *
 * Called by pg_cron on a timer (see migration 0008). Builds the briefing from
 * plain SQL and sends it to Telegram. No API key required, so this keeps
 * working whether or not the AI side is switched on.
 */




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
