// ---------------------------------------------------------------------------
// telegram.ts -- generated file, do not edit directly.
//
// Built from supabase/functions/telegram/index.ts and everything it imports, flattened
// into one file so it can be pasted straight into the Supabase dashboard's
// Edge Function editor. No terminal required.
//
// Edit the real source under supabase/functions/, then regenerate with:
//     python3 scripts/bundle.py
// ---------------------------------------------------------------------------

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk@0.124.0";
import * as XLSX from "npm:xlsx@0.18.5";
import { extractText, getDocumentProxy } from "npm:unpdf@0.12.1";

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

// ===== _shared/claude.ts ===========================================
/**
 * claude.ts -- the wrapper every agent calls through.
 *
 * Three jobs, in order of importance:
 *   1. Refuse to spend money you have not agreed to spend.
 *   2. Never let an NRIC reach the model.
 *   3. Run the tool loop.
 *
 * On the loop: this uses a manual agentic loop rather than the SDK's tool
 * runner. The runner is still beta, and this service runs unattended at 7am
 * with nobody watching -- a stable dependency is worth more here than the few
 * lines the runner would save. The loop also needs to re-check the budget
 * between iterations, which is cleaner to express directly.
 */





// ---------------------------------------------------------------------------
// Cost model. Dollars per million tokens, from Anthropic's published pricing.
// Used only to enforce your daily cap -- the real bill is Anthropic's.
// Cache reads are billed at roughly a tenth of the input rate.
// ---------------------------------------------------------------------------

const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5.0, output: 25.0 },
  "claude-sonnet-5": { input: 2.0, output: 10.0 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
};

function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
): number {
  const rate = PRICING[model] ?? PRICING["claude-opus-5"];
  return (
    (inputTokens / 1_000_000) * rate.input +
    (outputTokens / 1_000_000) * rate.output +
    (cacheReadTokens / 1_000_000) * rate.input * 0.1
  );
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export class BudgetExceededError extends Error {
  constructor(public readonly spentToday: number, public readonly cap: number) {
    super(
      `Daily AI budget reached: US$${spentToday.toFixed(3)} of US$${cap.toFixed(2)}.`,
    );
    this.name = "BudgetExceededError";
  }
}

/** The cap from the database if set, otherwise the one from the environment. */
async function currentCap(): Promise<number> {
  const { data } = await db()
    .from("app_settings")
    .select("daily_spend_cap_usd")
    .eq("id", 1)
    .maybeSingle();

  const fromDb = data?.daily_spend_cap_usd;
  return fromDb != null ? Number(fromDb) : config.dailyCapUsd;
}

export async function spendToday(): Promise<number> {
  try {
    return Number(await rpc<number>("ai_spend_today"));
  } catch (e) {
    // If the ledger is unreadable, assume the worst and stop. Failing closed on
    // a spending control is the only defensible direction.
    console.error("could not read today's spend", e);
    throw new Error("Spend ledger unavailable; refusing to call the model.");
  }
}

async function assertWithinBudget(): Promise<void> {
  const [spent, cap] = await Promise.all([spendToday(), currentCap()]);
  if (spent >= cap) throw new BudgetExceededError(spent, cap);
}

async function recordUsage(
  agent: string,
  model: string,
  usage: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  },
): Promise<void> {
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;

  try {
    await db().from("ai_usage").insert({
      agent,
      model,
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: cacheRead,
      est_cost_usd: estimateCost(model, input, output, cacheRead),
    });
  } catch (e) {
    console.error("failed to record AI usage", e);  // never fail a reply over bookkeeping
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

let anthropic: Anthropic | null = null;

function anthropicClient(): Anthropic {
  if (!aiEnabled()) {
    throw new Error(
      "No ANTHROPIC_API_KEY is set, so the manager and staff are not awake. " +
        "Scheduled alerts still work.",
    );
  }
  if (!anthropic) anthropic = new Anthropic({ apiKey: config.anthropicKey });
  return anthropic;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface AgentTool {
  name: string;
  description: string;
  // deno-lint-ignore no-explicit-any
  input_schema: any;
  run: (input: Record<string, unknown>) => Promise<unknown>;
}

export interface RunOptions {
  /** Label for the usage ledger, e.g. "manager" or "staff:policy". */
  agent: string;
  system: string;
  messages: Anthropic.MessageParam[];
  tools?: AgentTool[];
  model?: string;
  maxTokens?: number;
  /** low for focused staff lookups, medium for the manager's judgement calls. */
  effort?: "low" | "medium" | "high";
  /** Stops a misbehaving loop from burning the day's budget in one turn. */
  maxIterations?: number;
}

export interface RunResult {
  text: string;
  costUsd: number;
  iterations: number;
  toolsUsed: string[];
}

/**
 * Run an agent to completion: call the model, execute any tools it asks for,
 * feed the results back, repeat until it answers.
 */
export async function runAgent(opts: RunOptions): Promise<RunResult> {
  await assertWithinBudget();

  const model = opts.model ?? config.managerModel;
  const maxIterations = opts.maxIterations ?? 8;
  const tools = opts.tools ?? [];
  const toolsUsed: string[] = [];

  const toolDefs = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));

  const byName = new Map(tools.map((t) => [t.name, t]));
  const messages: Anthropic.MessageParam[] = [...opts.messages];

  let costUsd = 0;
  let iterations = 0;
  let finalText = "";

  while (iterations < maxIterations) {
    iterations += 1;

    const response = await anthropicClient().messages.create({
      model,
      max_tokens: opts.maxTokens ?? 8000,
      // The system prompt is identical on every call, so caching it turns the
      // largest stable chunk of each request into a tenth-price cache read.
      system: [{
        type: "text",
        text: opts.system,
        cache_control: { type: "ephemeral" },
      }],
      output_config: { effort: opts.effort ?? "medium" },
      ...(toolDefs.length > 0 ? { tools: toolDefs } : {}),
      messages,
    });

    costUsd += estimateCost(
      model,
      response.usage.input_tokens ?? 0,
      response.usage.output_tokens ?? 0,
      response.usage.cache_read_input_tokens ?? 0,
    );
    await recordUsage(opts.agent, model, response.usage);

    // Collect any text the model produced this turn.
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (text) finalText = text;

    if (response.stop_reason === "refusal") {
      return {
        text: "I could not answer that one. Try rephrasing it?",
        costUsd,
        iterations,
        toolsUsed,
      };
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (toolUses.length === 0) break;

    messages.push({ role: "assistant", content: response.content });

    // Run the requested tools in parallel, then return every result in one
    // user message. Splitting them across messages teaches the model to stop
    // asking for parallel work.
    const results = await Promise.all(
      toolUses.map(async (use): Promise<Anthropic.ToolResultBlockParam> => {
        const tool = byName.get(use.name);
        if (!tool) {
          return {
            type: "tool_result",
            tool_use_id: use.id,
            content: `No such tool: ${use.name}`,
            is_error: true,
          };
        }
        toolsUsed.push(use.name);
        try {
          const out = await tool.run(use.input as Record<string, unknown>);
          return {
            type: "tool_result",
            tool_use_id: use.id,
            content: scrubNric(
              typeof out === "string" ? out : JSON.stringify(out, null, 1),
            ),
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`tool ${use.name} failed:`, msg);
          return {
            type: "tool_result",
            tool_use_id: use.id,
            content: `That lookup failed: ${msg}`,
            is_error: true,
          };
        }
      }),
    );

    messages.push({ role: "user", content: results });

    // Re-check between iterations. A runaway loop is exactly the scenario the
    // cap exists for, and waiting until the next turn is too late.
    await assertWithinBudget();
  }

  if (!finalText) {
    finalText =
      "I looked, but could not put together a clear answer. Ask me a narrower question?";
  }

  return { text: finalText, costUsd, iterations, toolsUsed };
}

// ===== _shared/staff/tools.ts ======================================
/**
 * staff/tools.ts -- the database lookups the staff are allowed to perform.
 *
 * Each tool is deliberately narrow. A staff member holds only the tools for
 * their own desk, which means the birthday clerk genuinely cannot read a policy
 * contract, and the product desk genuinely cannot see your client list. That
 * is not decoration: it keeps each agent's context small (cheaper, sharper) and
 * limits what any single confused agent can do.
 */




/** Every tool result passes through here, so nothing reaches a model unscrubbed. */
async function safe<T>(fn: () => Promise<T>): Promise<T> {
  return scrubDeep(await fn());
}

// ---------------------------------------------------------------------------
// Shared: finding a person
// ---------------------------------------------------------------------------

export const findClient: AgentTool = {
  name: "find_client",
  description:
    "Find clients by name, partial name, or nickname. Use this first whenever " +
    "the adviser mentions someone by name, to get their client_id. Returns " +
    "possible matches -- if more than one comes back, ask which they meant.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Full or partial name to search for" },
    },
    required: ["name"],
    additionalProperties: false,
  },
  run: (input) =>
    safe(async () => {
      const name = String(input.name ?? "").trim();
      if (!name) return { matches: [] };

      const { data, error } = await db()
        .from("clients")
        .select(
          "id, full_name, preferred_name, dob, status, occupation, " +
            "last_contacted_at, residency, marital_status",
        )
        .ilike("full_name", `%${name}%`)
        .limit(10);

      if (error) throw new Error(error.message);
      return {
        matches: data ?? [],
        note: data?.length === 0 ? "No client by that name is on file." : undefined,
      };
    }),
};

export const getDossier: AgentTool = {
  name: "get_client_dossier",
  description:
    "Everything on file about one client: their details, family, all policies, " +
    "the last ten conversations, open follow-ups and live opportunities. " +
    "Requires a client_id from find_client.",
  input_schema: {
    type: "object",
    properties: {
      client_id: { type: "string", description: "UUID from find_client" },
    },
    required: ["client_id"],
    additionalProperties: false,
  },
  run: (input) =>
    safe(() => rpc("client_dossier", { target: String(input.client_id) })),
};

// ---------------------------------------------------------------------------
// Birthday and milestone desk
// ---------------------------------------------------------------------------

export const upcomingBirthdays: AgentTool = {
  name: "upcoming_birthdays",
  description:
    "Birthdays coming up, for clients and their family members. Family " +
    "birthdays are included because a child's birthday is often the better " +
    "reason to call, and milestone ages (1, 18, 21, 55, 65) matter for planning.",
  input_schema: {
    type: "object",
    properties: {
      days_ahead: {
        type: "integer",
        description: "How far to look ahead. Default 14, maximum 120.",
      },
    },
    required: [],
    additionalProperties: false,
  },
  run: (input) =>
    safe(async () => {
      const days = Math.min(Math.max(Number(input.days_ahead ?? 14), 0), 120);
      const { data, error } = await db()
        .from("v_upcoming_birthdays")
        .select("*")
        .gte("days_away", 0)
        .lte("days_away", days)
        .order("days_away", { ascending: true });

      if (error) throw new Error(error.message);
      return { window_days: days, birthdays: data ?? [] };
    }),
};

// ---------------------------------------------------------------------------
// Policy and premium desk
// ---------------------------------------------------------------------------

export const premiumsDue: AgentTool = {
  name: "premiums_due",
  description:
    "Premiums falling due, or already overdue. A negative days_away means the " +
    "premium is late and the policy is at risk of lapsing -- that is urgent.",
  input_schema: {
    type: "object",
    properties: {
      days_ahead: { type: "integer", description: "Default 30, maximum 180." },
      include_overdue: { type: "boolean", description: "Default true." },
    },
    required: [],
    additionalProperties: false,
  },
  run: (input) =>
    safe(async () => {
      const days = Math.min(Math.max(Number(input.days_ahead ?? 30), 0), 180);
      const includeOverdue = input.include_overdue !== false;

      let q = db().from("v_premiums_due").select("*").lte("days_away", days);
      if (!includeOverdue) q = q.gte("days_away", 0);

      const { data, error } = await q.order("days_away", { ascending: true });
      if (error) throw new Error(error.message);

      const rows = data ?? [];
      return {
        window_days: days,
        overdue_count: rows.filter((r) => Number(r.days_away) < 0).length,
        premiums: rows,
      };
    }),
};

export const policyAnniversaries: AgentTool = {
  name: "policy_anniversaries",
  description:
    "Policies reaching their inception anniversary. These are natural review " +
    "moments, and for term plans the year before a rate step-up is the moment " +
    "to act rather than after.",
  input_schema: {
    type: "object",
    properties: {
      days_ahead: { type: "integer", description: "Default 30, maximum 180." },
    },
    required: [],
    additionalProperties: false,
  },
  run: (input) =>
    safe(async () => {
      const days = Math.min(Math.max(Number(input.days_ahead ?? 30), 0), 180);
      const { data, error } = await db()
        .from("v_policy_anniversaries")
        .select("*")
        .gte("days_away", 0)
        .lte("days_away", days)
        .order("days_away", { ascending: true });

      if (error) throw new Error(error.message);
      return { window_days: days, anniversaries: data ?? [] };
    }),
};

export const listPolicies: AgentTool = {
  name: "list_policies",
  description:
    "Every policy for one client, including lapsed and matured ones. Use this " +
    "when asked what someone is covered for, or to spot a gap.",
  input_schema: {
    type: "object",
    properties: {
      client_id: { type: "string" },
      status: {
        type: "string",
        description: "Optional filter, e.g. in_force, lapsed, paid_up.",
      },
    },
    required: ["client_id"],
    additionalProperties: false,
  },
  run: (input) =>
    safe(async () => {
      let q = db()
        .from("policies")
        .select("*")
        .eq("client_id", String(input.client_id));

      if (input.status) q = q.eq("status", String(input.status));

      const { data, error } = await q.order("inception_date", { ascending: false });
      if (error) throw new Error(error.message);
      return { policies: data ?? [] };
    }),
};

export const portfolioSummary: AgentTool = {
  name: "portfolio_summary",
  description:
    "Totals across the whole book: how many clients, how many policies in " +
    "force, total annualised premium, and a breakdown by insurer and policy " +
    "type. Use for questions about the business as a whole.",
  input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  run: () =>
    safe(async () => {
      const { data, error } = await db()
        .from("policies")
        .select("insurer, policy_type, premium_amount, premium_mode, status, client_id")
        .eq("status", "in_force");

      if (error) throw new Error(error.message);
      const rows = data ?? [];

      // Annualise so that monthly and annual premiums are comparable.
      const multiplier: Record<string, number> = {
        monthly: 12, quarterly: 4, semi_annual: 2, annual: 1,
        single: 0, limited_pay: 1,
      };

      let annualised = 0;
      const byInsurer: Record<string, number> = {};
      const byType: Record<string, number> = {};

      for (const r of rows) {
        const amount = Number(r.premium_amount ?? 0);
        const annual = amount * (multiplier[String(r.premium_mode)] ?? 1);
        annualised += annual;
        byInsurer[String(r.insurer)] = (byInsurer[String(r.insurer)] ?? 0) + annual;
        byType[String(r.policy_type)] = (byType[String(r.policy_type)] ?? 0) + annual;
      }

      const { count: clientCount } = await db()
        .from("clients")
        .select("id", { count: "exact", head: true })
        .in("status", ["active", "prospect"]);

      return {
        clients: clientCount ?? 0,
        policies_in_force: rows.length,
        distinct_clients_with_cover: new Set(rows.map((r) => r.client_id)).size,
        annualised_premium: Math.round(annualised),
        by_insurer: byInsurer,
        by_policy_type: byType,
      };
    }),
};

// ---------------------------------------------------------------------------
// Sales desk -- who is worth your time this week
// ---------------------------------------------------------------------------

export const whoToSee: AgentTool = {
  name: "who_to_see",
  description:
    "A ranked list of clients worth contacting now, with the reason for each. " +
    "Scoring is done in code, not guessed: overdue contact, upcoming birthday, " +
    "premium due, policy anniversary, open promises and never-reviewed cover " +
    "all contribute. Use this for 'who should I see this week'.",
  input_schema: {
    type: "object",
    properties: {
      limit: { type: "integer", description: "How many to return. Default 8, max 25." },
    },
    required: [],
    additionalProperties: false,
  },
  run: (input) =>
    safe(async () => {
      const limit = Math.min(Math.max(Number(input.limit ?? 8), 1), 25);

      // Pull the signals in parallel, then score. Doing the arithmetic here
      // rather than asking the model to do it means the ranking is consistent
      // and explainable -- you can audit why someone is at the top.
      const [quiet, birthdays, premiums, anniversaries, actions] = await Promise.all([
        db().from("v_clients_gone_quiet").select("*"),
        db().from("v_upcoming_birthdays").select("*").gte("days_away", 0).lte("days_away", 14),
        db().from("v_premiums_due").select("*").lte("days_away", 21),
        db().from("v_policy_anniversaries").select("*").gte("days_away", 0).lte("days_away", 21),
        db().from("v_open_actions").select("*"),
      ]);

      interface Candidate {
        client_id: string;
        name: string;
        score: number;
        reasons: string[];
        phone?: string;
      }
      const pool = new Map<string, Candidate>();

      const add = (
        id: string | null | undefined,
        name: string,
        points: number,
        reason: string,
        phone?: string,
      ) => {
        if (!id) return;
        const existing = pool.get(id);
        if (existing) {
          existing.score += points;
          existing.reasons.push(reason);
        } else {
          pool.set(id, { client_id: id, name, score: points, reasons: [reason], phone });
        }
      };

      for (const r of quiet.data ?? []) {
        const overdue = Number(r.days_overdue);
        // Never contacted is its own category, not just "very overdue".
        const points = overdue >= 9999 ? 45 : Math.min(40, 12 + overdue / 15);
        const label = overdue >= 9999
          ? "never contacted since being added"
          : `${r.days_since_contact} days since last contact (${r.days_overdue} past your own cadence)`;
        add(r.client_id, String(r.client_name), points, label, r.phone as string);
      }

      for (const r of birthdays.data ?? []) {
        const whose = r.whose === "family"
          ? `${r.display_name}'s birthday (${r.relationship})`
          : "birthday";
        add(
          r.client_id,
          String(r.client_name),
          r.whose === "family" ? 14 : 20,
          `${whose} in ${r.days_away} days, turning ${r.turning}`,
          r.phone as string,
        );
      }

      for (const r of premiums.data ?? []) {
        const days = Number(r.days_away);
        add(
          r.client_id,
          String(r.client_name),
          days < 0 ? 50 : 22,   // overdue premium is the most urgent thing here
          days < 0
            ? `PREMIUM OVERDUE ${Math.abs(days)} days: ${r.insurer} ${r.plan_name}, $${r.premium_amount} -- lapse risk`
            : `premium due in ${days} days: ${r.insurer} ${r.plan_name}, $${r.premium_amount}`,
          r.phone as string,
        );
      }

      for (const r of anniversaries.data ?? []) {
        const neverReviewed = r.last_reviewed_at == null;
        add(
          r.client_id,
          String(r.client_name),
          neverReviewed ? 26 : 16,
          `${r.plan_name} hits year ${r.years_in_force} in ${r.days_away} days` +
            (neverReviewed ? " and has never been reviewed" : ""),
          undefined,
        );
      }

      for (const r of actions.data ?? []) {
        const days = Number(r.days_away ?? 0);
        if (r.due_date && days < 0) {
          add(
            r.client_id as string,
            String(r.client_name ?? "unknown"),
            30,
            `you promised: "${r.title}" -- ${Math.abs(days)} days overdue`,
          );
        }
      }

      const ranked = [...pool.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((c) => ({
          client_id: c.client_id,
          name: c.name,
          priority_score: Math.round(c.score),
          reasons: c.reasons,
          phone: c.phone,
        }));

      return {
        generated: new Date().toISOString(),
        scoring_note:
          "Scores are computed in code from real signals. Overdue premiums and " +
          "broken promises rank highest because both cost trust.",
        candidates: ranked,
      };
    }),
};

export const coverageGaps: AgentTool = {
  name: "coverage_gaps",
  description:
    "Structural gaps in a client's cover: no hospital plan, no critical " +
    "illness, no disability income, dependants with no protection, or cover " +
    "that has not moved since a major life event. Returns the facts -- you " +
    "judge whether a gap is worth raising.",
  input_schema: {
    type: "object",
    properties: {
      client_id: { type: "string" },
    },
    required: ["client_id"],
    additionalProperties: false,
  },
  run: (input) =>
    safe(async () => {
      const clientId = String(input.client_id);

      const [clientRes, policyRes, familyRes] = await Promise.all([
        db().from("clients").select("*").eq("id", clientId).maybeSingle(),
        db().from("policies").select("*").eq("client_id", clientId).eq("status", "in_force"),
        db().from("family_members").select("*").eq("client_id", clientId),
      ]);

      const client = clientRes.data;
      if (!client) throw new Error("No such client.");

      const policies = policyRes.data ?? [];
      const family = familyRes.data ?? [];
      const types = new Set(policies.map((p) => String(p.policy_type)));

      const gaps: string[] = [];

      if (!types.has("hospital")) {
        gaps.push(
          "No hospital or Integrated Shield plan on file. Worth confirming " +
            "whether they hold one elsewhere -- MediShield Life alone leaves a " +
            "large gap for private care.",
        );
      }
      if (!types.has("ci_standalone") && !policies.some((p) => (p.riders ?? []).length > 0)) {
        gaps.push("No critical illness cover on file, and no riders recorded.");
      }
      if (!types.has("disability")) {
        gaps.push("No disability income cover on file.");
      }
      if (!types.has("term_life") && !types.has("whole_life")) {
        gaps.push("No death cover on file at all.");
      }

      const dependants = family.filter((f) => f.is_dependent);
      const uninsuredDependants = dependants.filter((f) => !f.is_insured);
      if (uninsuredDependants.length > 0) {
        gaps.push(
          `${uninsuredDependants.length} dependant(s) with no cover recorded: ` +
            uninsuredDependants.map((f) => f.name ?? f.relationship).join(", "),
        );
      }

      // Protection-gap benchmarks from the LIA Singapore Protection Gap Study:
      // 9x annual income for death and TPD, 4x for critical illness. These are
      // the figures the insurers' own tools quote, so using anything else puts
      // this system at odds with the illustration the client is holding.
      const LIA_DEATH_MULTIPLE = 9;
      const LIA_CI_MULTIPLE = 4;

      const sumFor = (types: string[]) =>
        policies
          .filter((p) => types.includes(String(p.policy_type)))
          .reduce((sum, p) => sum + Number(p.sum_assured ?? 0), 0);

      const deathCover = sumFor(["term_life", "whole_life"]);
      const ciCover = sumFor(["ci_standalone"]);

      const income = Number(client.annual_income ?? 0);
      let coverMultiple: number | null = null;
      let recommendedDeath: number | null = null;
      let recommendedCi: number | null = null;

      if (income > 0) {
        recommendedDeath = income * LIA_DEATH_MULTIPLE;
        recommendedCi = income * LIA_CI_MULTIPLE;

        if (deathCover > 0) coverMultiple = Number((deathCover / income).toFixed(1));

        if (deathCover < recommendedDeath) {
          gaps.push(
            `Death cover is ${deathCover.toLocaleString()} against an LIA benchmark of ` +
              `${recommendedDeath.toLocaleString()} (9x income). Shortfall ` +
              `${(recommendedDeath - deathCover).toLocaleString()}.`,
          );
        }
        if (ciCover < recommendedCi) {
          gaps.push(
            `Critical illness cover is ${ciCover.toLocaleString()} against an LIA ` +
              `benchmark of ${recommendedCi.toLocaleString()} (4x income). Shortfall ` +
              `${(recommendedCi - ciCover).toLocaleString()}.`,
          );
        }
      } else {
        gaps.push(
          "No annual income on file, so the protection-gap benchmarks cannot be " +
            "calculated. Worth adding -- it is what the 9x and 4x figures multiply.",
        );
      }

      const stale = policies.filter((p) => {
        if (!p.last_reviewed_at) return true;
        const days = (Date.now() - new Date(String(p.last_reviewed_at)).getTime()) / 86400000;
        return days > 730;
      });

      return {
        client: {
          name: client.full_name,
          residency: client.residency,
          marital_status: client.marital_status,
          annual_income: client.annual_income,
          dependants: dependants.length,
        },
        policies_in_force: policies.length,
        policy_types_held: [...types],
        total_death_cover: deathCover,
        total_ci_cover: ciCover,
        cover_multiple_of_income: coverMultiple,
        lia_benchmark_death: recommendedDeath,
        lia_benchmark_ci: recommendedCi,
        benchmark_source:
          "LIA Singapore Protection Gap Study: 9x annual income for death and TPD, " +
          "4x for critical illness. The same basis the insurers' own portfolio " +
          "summaries quote.",
        never_or_long_unreviewed: stale.map((p) => `${p.insurer} ${p.plan_name}`),
        gaps,
        caution:
          "These are data observations, not recommendations. Suitability depends " +
          "on facts not in this database.",
      };
    }),
};

export const listOpportunities: AgentTool = {
  name: "list_opportunities",
  description: "Open and in-progress opportunities across the book.",
  input_schema: {
    type: "object",
    properties: {
      client_id: { type: "string", description: "Optional: limit to one client." },
      status: { type: "string", description: "Default open and working." },
    },
    required: [],
    additionalProperties: false,
  },
  run: (input) =>
    safe(async () => {
      let q = db()
        .from("opportunities")
        .select("*, clients(full_name, preferred_name)");

      if (input.client_id) q = q.eq("client_id", String(input.client_id));
      q = input.status
        ? q.eq("status", String(input.status))
        : q.in("status", ["open", "working"]);

      const { data, error } = await q.order("next_step_date", {
        ascending: true,
        nullsFirst: false,
      });
      if (error) throw new Error(error.message);
      return { opportunities: data ?? [] };
    }),
};

// ---------------------------------------------------------------------------
// Relationship desk -- what you actually talked about
// ---------------------------------------------------------------------------

export const recentConversations: AgentTool = {
  name: "recent_conversations",
  description:
    "What was discussed with a client, most recent first. Use this before any " +
    "meeting so you walk in knowing what you said last time and what you " +
    "promised. Without a client_id, returns recent conversations across everyone.",
  input_schema: {
    type: "object",
    properties: {
      client_id: { type: "string", description: "Optional: one client only." },
      limit: { type: "integer", description: "Default 10, max 40." },
    },
    required: [],
    additionalProperties: false,
  },
  run: (input) =>
    safe(async () => {
      const limit = Math.min(Math.max(Number(input.limit ?? 10), 1), 40);
      let q = db()
        .from("interactions")
        .select("id, client_id, occurred_at, channel, summary, detail, topics, sentiment, ai_generated, clients(full_name)");

      if (input.client_id) q = q.eq("client_id", String(input.client_id));

      const { data, error } = await q
        .order("occurred_at", { ascending: false })
        .limit(limit);

      if (error) throw new Error(error.message);
      return { conversations: data ?? [] };
    }),
};

export const searchNotes: AgentTool = {
  name: "search_notes",
  description:
    "Search across every meeting note for a word or phrase. Use for questions " +
    "like 'who mentioned retiring early' or 'which clients talked about their " +
    "children's education'.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Word or phrase to look for." },
      limit: { type: "integer", description: "Default 15, max 40." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  run: (input) =>
    safe(async () => {
      const query = String(input.query ?? "").trim();
      const limit = Math.min(Math.max(Number(input.limit ?? 15), 1), 40);
      if (!query) return { results: [] };

      const { data, error } = await db()
        .from("interactions")
        .select("id, client_id, occurred_at, channel, summary, detail, topics, clients(full_name)")
        .or(`summary.ilike.%${query}%,detail.ilike.%${query}%`)
        .order("occurred_at", { ascending: false })
        .limit(limit);

      if (error) throw new Error(error.message);
      return { query, results: data ?? [] };
    }),
};

export const openPromises: AgentTool = {
  name: "open_promises",
  description:
    "Things you said you would do and have not closed off. Overdue ones are " +
    "listed first, because those are the ones that cost trust.",
  input_schema: {
    type: "object",
    properties: {
      client_id: { type: "string", description: "Optional: one client only." },
    },
    required: [],
    additionalProperties: false,
  },
  run: (input) =>
    safe(async () => {
      let q = db().from("v_open_actions").select("*");
      if (input.client_id) q = q.eq("client_id", String(input.client_id));

      const { data, error } = await q.order("due_date", {
        ascending: true,
        nullsFirst: false,
      });
      if (error) throw new Error(error.message);

      const rows = data ?? [];
      return {
        overdue: rows.filter((r) => r.days_away != null && Number(r.days_away) < 0),
        upcoming: rows.filter((r) => r.days_away == null || Number(r.days_away) >= 0),
      };
    }),
};

// ---------------------------------------------------------------------------
// Product desk -- the library
// ---------------------------------------------------------------------------

export const searchProducts: AgentTool = {
  name: "search_product_documents",
  description:
    "Search the uploaded product summaries, brochures and policy contracts. " +
    "Returns the actual text of the matching passages along with which document " +
    "and page they came from. ALWAYS quote from what comes back and name the " +
    "document -- never answer a product question from memory.\n\n" +
    "Each result carries a match_type. 'exact' means every search term was " +
    "found. 'partial' means only some were, so read the passage carefully " +
    "before relying on it and tell the manager it was a loose match.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Search terms. Insurance wording is precise, so prefer exact terms " +
          "like 'deferment period' or 'pre-existing condition exclusion'.",
      },
      insurer: { type: "string", description: "Optional insurer filter." },
      max_results: { type: "integer", description: "Default 8, max 20." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  run: (input) =>
    safe(async () => {
      const results = await rpc<unknown[]>("search_products", {
        query_text: String(input.query),
        insurer_filter: input.insurer ? String(input.insurer) : null,
        max_results: Math.min(Math.max(Number(input.max_results ?? 8), 1), 20),
      });
      return {
        query: input.query,
        passages: results ?? [],
        note: (results ?? []).length === 0
          ? "Nothing in the library matches. The document may not be uploaded yet."
          : undefined,
      };
    }),
};

export const listProducts: AgentTool = {
  name: "list_product_documents",
  description:
    "What is actually in the product library: which documents have been " +
    "uploaded, for which insurer, and whether they are current or superseded.",
  input_schema: {
    type: "object",
    properties: {
      insurer: { type: "string", description: "Optional insurer filter." },
    },
    required: [],
    additionalProperties: false,
  },
  run: (input) =>
    safe(async () => {
      let q = db()
        .from("products")
        .select("id, insurer, name, product_type, doc_type, status, effective_date, page_count, ingested_at");

      if (input.insurer) q = q.ilike("insurer", `%${input.insurer}%`);

      const { data, error } = await q.order("insurer").order("name");
      if (error) throw new Error(error.message);
      return { documents: data ?? [] };
    }),
};

// ---------------------------------------------------------------------------
// Write tools -- filing what you tell the manager
//
// These are the only tools that change anything. They are held by the manager
// alone, not handed out to the read-only desks, so that a lookup agent can
// never modify your client book as a side effect of answering a question.
// ---------------------------------------------------------------------------

export const logInteraction: AgentTool = {
  name: "log_interaction",
  description:
    "File a meeting, call or conversation against a client. Use this whenever " +
    "the adviser tells you about something that happened -- 'just saw Mr Tan', " +
    "'called Sarah about her renewal'. Write the summary in the adviser's own " +
    "words as far as possible.",
  input_schema: {
    type: "object",
    properties: {
      client_id: { type: "string" },
      summary: {
        type: "string",
        description: "One or two lines. This is what gets re-read before the next meeting.",
      },
      detail: { type: "string", description: "The fuller note, if there is one." },
      channel: {
        type: "string",
        enum: ["meeting", "call", "whatsapp", "email", "telegram", "event", "note", "other"],
      },
      topics: {
        type: "array",
        items: { type: "string" },
        description: "Short tags, e.g. ['retirement', 'cpf_sa_topup', 'newborn'].",
      },
      sentiment: {
        type: "string",
        enum: ["positive", "neutral", "concerned", "negative"],
      },
      occurred_at: {
        type: "string",
        description: "ISO timestamp. Defaults to now if the adviser did not say when.",
      },
    },
    required: ["client_id", "summary"],
    additionalProperties: false,
  },
  run: (input) =>
    safe(async () => {
      const { data, error } = await db()
        .from("interactions")
        .insert({
          client_id: String(input.client_id),
          summary: String(input.summary),
          detail: input.detail ? String(input.detail) : null,
          channel: input.channel ? String(input.channel) : "meeting",
          topics: Array.isArray(input.topics) ? input.topics.map(String) : null,
          sentiment: input.sentiment ? String(input.sentiment) : null,
          occurred_at: input.occurred_at ? String(input.occurred_at) : new Date().toISOString(),
          ai_generated: true,
        })
        .select("id, occurred_at")
        .single();

      if (error) throw new Error(error.message);
      return { filed: true, interaction_id: data.id, occurred_at: data.occurred_at };
    }),
};

export const createAction: AgentTool = {
  name: "create_action_item",
  description:
    "Record something the adviser needs to do. Create one whenever a promise " +
    "is implied -- 'I'll send him the quote', 'need to check her Shield tier'.",
  input_schema: {
    type: "object",
    properties: {
      client_id: { type: "string", description: "Optional if not client-specific." },
      title: { type: "string", description: "Short and actionable." },
      detail: { type: "string" },
      due_date: { type: "string", description: "YYYY-MM-DD." },
      priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
    },
    required: ["title"],
    additionalProperties: false,
  },
  run: (input) =>
    safe(async () => {
      const { data, error } = await db()
        .from("action_items")
        .insert({
          client_id: input.client_id ? String(input.client_id) : null,
          title: String(input.title),
          detail: input.detail ? String(input.detail) : null,
          due_date: input.due_date ? String(input.due_date) : null,
          priority: input.priority ? String(input.priority) : "normal",
        })
        .select("id")
        .single();

      if (error) throw new Error(error.message);
      return { created: true, action_id: data.id };
    }),
};

export const upsertClient: AgentTool = {
  name: "create_or_update_client",
  description:
    "Add a new client, or update details on an existing one. Pass client_id to " +
    "update; leave it out to create. Never store an NRIC -- it will be stripped " +
    "automatically, and you should not ask for one.",
  input_schema: {
    type: "object",
    properties: {
      client_id: { type: "string", description: "Omit to create a new client." },
      full_name: { type: "string" },
      preferred_name: { type: "string" },
      dob: { type: "string", description: "YYYY-MM-DD." },
      gender: { type: "string", enum: ["M", "F", "other"] },
      marital_status: { type: "string", enum: ["single", "married", "divorced", "widowed"] },
      residency: { type: "string", enum: ["citizen", "pr", "ep_spass", "foreigner", "unknown"] },
      occupation: { type: "string" },
      employer: { type: "string" },
      annual_income: { type: "number" },
      phone: { type: "string" },
      email: { type: "string" },
      address_area: { type: "string" },
      status: {
        type: "string",
        enum: ["prospect", "active", "dormant", "lapsed", "referral_only", "former"],
      },
      profile_notes: {
        type: "string",
        description: "Standing context: hobbies, children's names, how they like to be contacted.",
      },
      review_interval_days: {
        type: "integer",
        description: "How often this client expects to hear from you. Default 180.",
      },
    },
    required: [],
    additionalProperties: false,
  },
  run: (input) =>
    safe(async () => {
      const { client_id, ...fields } = input;

      // Strip undefined so an update never blanks a field the model did not mention.
      const payload = Object.fromEntries(
        Object.entries(fields).filter(([, v]) => v !== undefined && v !== null),
      );

      if (client_id) {
        const { data, error } = await db()
          .from("clients")
          .update(payload)
          .eq("id", String(client_id))
          .select("id, full_name")
          .single();
        if (error) throw new Error(error.message);
        return { updated: true, client_id: data.id, full_name: data.full_name };
      }

      if (!payload.full_name) throw new Error("full_name is required to create a client.");

      const { data, error } = await db()
        .from("clients")
        .insert(payload)
        .select("id, full_name")
        .single();
      if (error) throw new Error(error.message);
      return { created: true, client_id: data.id, full_name: data.full_name };
    }),
};

export const addFamilyMember: AgentTool = {
  name: "add_family_member",
  description:
    "Record a spouse, child or dependant. Worth doing whenever one is " +
    "mentioned -- a child's birthday is a reason to call, and a new baby is " +
    "the most reliable trigger for a cover conversation there is.",
  input_schema: {
    type: "object",
    properties: {
      client_id: { type: "string" },
      name: { type: "string" },
      relationship: {
        type: "string",
        enum: ["spouse", "child", "parent", "sibling", "domestic_partner", "other"],
      },
      dob: { type: "string", description: "YYYY-MM-DD if known." },
      is_dependent: { type: "boolean" },
      is_insured: { type: "boolean" },
      notes: { type: "string" },
    },
    required: ["client_id", "relationship"],
    additionalProperties: false,
  },
  run: (input) =>
    safe(async () => {
      const { data, error } = await db()
        .from("family_members")
        .insert({
          client_id: String(input.client_id),
          name: input.name ? String(input.name) : null,
          relationship: String(input.relationship),
          dob: input.dob ? String(input.dob) : null,
          is_dependent: Boolean(input.is_dependent ?? false),
          is_insured: Boolean(input.is_insured ?? false),
          notes: input.notes ? String(input.notes) : null,
        })
        .select("id")
        .single();

      if (error) throw new Error(error.message);
      return { added: true, family_member_id: data.id };
    }),
};

export const createOpportunity: AgentTool = {
  name: "create_opportunity",
  description:
    "Record a live opportunity: a gap worth revisiting, a review that is due, " +
    "a referral offered. Use when the adviser describes something worth " +
    "following up on later rather than now.",
  input_schema: {
    type: "object",
    properties: {
      client_id: { type: "string" },
      kind: {
        type: "string",
        enum: [
          "protection_gap", "retirement_gap", "review_due", "upsell",
          "cross_sell", "referral", "claim_support", "lapse_risk",
        ],
      },
      headline: { type: "string" },
      rationale: { type: "string" },
      est_annual_premium: { type: "number" },
      next_step: { type: "string" },
      next_step_date: { type: "string", description: "YYYY-MM-DD." },
    },
    required: ["client_id", "kind", "headline"],
    additionalProperties: false,
  },
  run: (input) =>
    safe(async () => {
      const { data, error } = await db()
        .from("opportunities")
        .insert({
          client_id: String(input.client_id),
          kind: String(input.kind),
          headline: String(input.headline),
          rationale: input.rationale ? String(input.rationale) : null,
          est_annual_premium: input.est_annual_premium ?? null,
          next_step: input.next_step ? String(input.next_step) : null,
          next_step_date: input.next_step_date ? String(input.next_step_date) : null,
        })
        .select("id")
        .single();

      if (error) throw new Error(error.message);
      return { created: true, opportunity_id: data.id };
    }),
};

export const completeAction: AgentTool = {
  name: "complete_action_item",
  description: "Mark a promise as done, or drop it if it is no longer relevant.",
  input_schema: {
    type: "object",
    properties: {
      action_id: { type: "string" },
      outcome: { type: "string", enum: ["done", "dropped"] },
    },
    required: ["action_id"],
    additionalProperties: false,
  },
  run: (input) =>
    safe(async () => {
      const outcome = String(input.outcome ?? "done");
      const { error } = await db()
        .from("action_items")
        .update({
          status: outcome,
          completed_at: outcome === "done" ? new Date().toISOString() : null,
        })
        .eq("id", String(input.action_id));

      if (error) throw new Error(error.message);
      return { updated: true, status: outcome };
    }),
};

export const medisaveCheck: AgentTool = {
  name: "medisave_check",
  description:
    "Whether a policy line can be paid from MediSave, and up to what annual " +
    "limit. Reads the published CPF limits from the database rather than " +
    "relying on recall, because these are revised periodically and a stale " +
    "figure quoted to a client is a real problem. Use this for ANY question " +
    "about CPF, MediSave or how a Shield premium is funded.",
  input_schema: {
    type: "object",
    properties: {
      coverage_type: {
        type: "string",
        description: "The policy's coverage_type, e.g. 'Hospitalisation', 'Death'.",
      },
      is_rider: {
        type: "boolean",
        description:
          "True for an Integrated Shield rider. Riders are never MediSave-payable.",
      },
      age_next_birthday: { type: "integer" },
    },
    required: ["coverage_type", "is_rider", "age_next_birthday"],
    additionalProperties: false,
  },
  run: (input) =>
    safe(() =>
      rpc("medisave_payable", {
        policy_coverage_type: String(input.coverage_type),
        policy_is_rider: Boolean(input.is_rider),
        age_next_birthday: Number(input.age_next_birthday),
      })
    ),
};

// ===== _shared/staff/index.ts ======================================
/**
 * staff/index.ts -- the desks.
 *
 * Each desk is a specialist you never speak to directly. The manager sends
 * them a question, they look it up with their own narrow set of tools, and
 * they report back. You only ever see the manager's reply.
 *
 * Why bother with the separation instead of one big agent with every tool?
 * Three reasons that matter in practice:
 *   - A desk with six tools chooses better than one with thirty.
 *   - Each desk's context stays small, which is both cheaper and sharper.
 *   - The read-only desks hold no write tools, so a lookup can never quietly
 *     change your client book.
 */





export interface Desk {
  key: string;
  /** How the manager sees them on the org chart. */
  title: string;
  /** Shown to the manager as the delegate tool's description. */
  remit: string;
  brief: string;
  tools: AgentTool[];
}

const HOUSE_RULES = `
You work for a licensed financial services consultant in Singapore. You are a
back-office specialist: you look things up and report back to the manager. You
never speak to the adviser directly and never to a client.

How to report back:
- Lead with the answer. The manager is relaying this to a busy adviser between
  appointments.
- Give concrete facts: names, dates, dollar amounts, day counts. Not "soon" but
  "in 4 days". Not "a few policies" but "three".
- If the data does not contain the answer, say exactly that. Do not fill the
  gap with something plausible. An invented policy number or premium figure
  could end up in front of a client, and that is a licensing problem, not a
  typo.
- Distinguish what the records show from what you are inferring. "No hospital
  plan on file" is a fact. "They probably need one" is a judgement, and the
  adviser makes those, not you.
- Never state or ask for an NRIC or FIN. They are deliberately not stored here.
- Be brief. Three sentences beats a page.
`.trim();

function deskBrief(desk: Omit<Desk, "brief">): string {
  return `${HOUSE_RULES}

YOUR DESK: ${desk.title}
${desk.remit}

Today is ${sgNow()} Singapore time (${sgToday()}).`;
}

// ---------------------------------------------------------------------------
// The five desks
// ---------------------------------------------------------------------------

const birthdayDesk: Omit<Desk, "brief"> = {
  key: "birthdays",
  title: "Birthdays and milestones",
  remit: `You track birthdays and life milestones for clients and their families.

What you watch for beyond the date itself:
- Milestone ages that carry planning weight in Singapore: 18 and 21 (a child
  ages out of some covers), 55 (CPF withdrawal and the Retirement Account),
  65 (CPF LIFE payouts begin), plus round decades.
- Children's birthdays, which are frequently the warmer reason to make contact.
- Whether the adviser has actually been in touch recently, so a birthday
  greeting does not land as the first contact in a year.

When you report a birthday, say who, when, what age they turn, and whether
anything about that age is worth knowing.`,
  tools: [findClient, upcomingBirthdays, getDossier],
};

const policyDesk: Omit<Desk, "brief"> = {
  key: "policies",
  title: "Policies, premiums and anniversaries",
  remit: `You know every policy on the book: what is in force, what it costs,
when it renews, and when the money is due.

Priorities, in order:
- An overdue premium is the most urgent thing you deal with. A lapsed policy
  can mean lost cover and, for older clients, cover that cannot be replaced at
  any price. Always flag these first and say how many days late.
- Policy anniversaries, especially where the policy has never been reviewed.
- CPF-funded premiums, which fail differently from cash ones: a MediSave or
  OA shortfall can lapse a policy without any bounced payment the client
  notices.

WHAT MEDISAVE WILL AND WILL NOT PAY

Do not reason this out from first principles -- call medisave_check, which
reads the current published limits from the database. The rules that catch
people out:

- MediSave covers Integrated Shield Plan premiums ONLY. Life, CI, personal
  accident and everything else is cash or other funds.
- An Integrated Shield RIDER -- the add-on covering deductible and
  co-insurance -- can NEVER be paid from MediSave, at any age. Always cash.
  This is the one most often got wrong.
- For the plan itself, the MediShield Life component is fully MediSave-payable,
  and the private component is payable up to an Additional Withdrawal Limit
  that depends on age. Anything above that is cash.

Policy numbers in an insurer's portfolio summary are usually MASKED to the last
four digits. Where you see policy_number_masked set and policy_number empty,
say so rather than reading the mask out as if it were the number.

Always give insurer, plan name, amount and date. Never guess a policy number.`,
  tools: [
    findClient, premiumsDue, policyAnniversaries,
    listPolicies, portfolioSummary, getDossier, medisaveCheck,
  ],
};

const salesDesk: Omit<Desk, "brief"> = {
  key: "sales",
  title: "Who to see",
  remit: `You decide who is worth the adviser's time this week, and you say why.

The who_to_see tool does the ranking in code rather than by feel, so the order
is consistent and auditable. Your job is to explain it usefully: turn a score
into a reason a busy person can act on.

What makes someone worth seeing:
- An overdue premium, because a lapse is imminent.
- A promise the adviser made and has not kept.
- A long silence against the cadence that client expects.
- A birthday or anniversary that gives a natural, non-salesy reason to call.
- A structural gap in cover.

Two things you never do: manufacture urgency that is not in the data, and
recommend a specific product. You say who and why. The adviser decides what to
bring. Suitability is their licensed judgement, not yours.`,
  tools: [
    findClient, whoToSee, coverageGaps,
    listOpportunities, getDossier, openPromises,
  ],
};

const relationshipDesk: Omit<Desk, "brief"> = {
  key: "relationship",
  title: "Relationship history",
  remit: `You are the memory. What was discussed, what was promised, what was
going on in someone's life the last time they spoke.

This desk earns its keep in the ten minutes before a meeting. When asked about
a client, give the adviser what they need to walk in sounding like someone who
was paying attention: what was last discussed, what is outstanding, and the
personal details that matter -- a child starting school, a parent unwell, a job
change.

Quote the adviser's own notes where you can rather than paraphrasing them. The
exact words they wrote will jog their memory better than your summary of them.

Flag anything promised and not delivered. That is the thing most likely to
cost the relationship.`,
  tools: [
    findClient, recentConversations, searchNotes,
    openPromises, getDossier,
  ],
};

const productDesk: Omit<Desk, "brief"> = {
  key: "products",
  title: "Product knowledge",
  remit: `You know the uploaded product summaries, brochures and policy
contracts. You hold no client data at all -- you read documents.

The one rule that matters: answer ONLY from what search_product_documents
returns. Never from memory, never from what you know about insurance generally.
Product terms differ between insurers and change between versions, and a
confidently wrong answer about an exclusion or a waiting period is exactly the
kind of thing that ends up as a complaint.

Always name the document you are quoting from, and the page if you have it, so
the adviser can verify before repeating it to a client.

If the library does not contain the answer, say so plainly and suggest the
document that would need uploading. That is a useful answer. A guess is not.`,
  tools: [searchProducts, listProducts],
};

function build(d: Omit<Desk, "brief">): Desk {
  return { ...d, brief: deskBrief(d) };
}

export const DESKS: Desk[] = [
  build(birthdayDesk),
  build(policyDesk),
  build(salesDesk),
  build(relationshipDesk),
  build(productDesk),
];

/**
 * Send a question to one desk and get their answer back.
 *
 * Runs at low effort deliberately: these are focused lookups inside a narrow
 * domain, where the work is retrieving the right rows rather than reasoning
 * hard about them. The manager does the thinking.
 */
export async function askDesk(deskKey: string, question: string): Promise<string> {
  const desk = DESKS.find((d) => d.key === deskKey);
  if (!desk) return `There is no desk called "${deskKey}".`;

  const result = await runAgent({
    agent: `staff:${desk.key}`,
    system: desk.brief,
    messages: [{ role: "user", content: question }],
    tools: desk.tools,
    model: config.staffModel,
    effort: "low",
    maxTokens: 4000,
    maxIterations: 6,
  });

  return result.text;
}

// ===== _shared/manager.ts ==========================================
/**
 * manager.ts -- the only one you talk to.
 *
 * The manager holds no lookup tools of their own. They hold one delegate tool
 * per desk, plus the write tools for filing what you tell them. When you ask a
 * question, the manager works out which desk owns it, asks them, and answers
 * you in one voice.
 *
 * That indirection is the point: you describe what you want in your own words
 * and never have to remember which system holds which fact.
 */







// ---------------------------------------------------------------------------
// Delegation: one tool per desk
// ---------------------------------------------------------------------------

const delegateTools: AgentTool[] = DESKS.map((desk) => ({
  name: `ask_${desk.key}`,
  description:
    `Put a question to the ${desk.title} desk.\n\n${desk.remit}\n\n` +
    "Ask in a full sentence, including any client name or timeframe you " +
    "already know. They cannot see your conversation with the adviser -- only " +
    "what you send them.",
  input_schema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description:
          "A complete, self-contained question. Include names and dates you " +
          "already know rather than making them look it up again.",
      },
    },
    required: ["question"],
    additionalProperties: false,
  },
  run: async (input) => await askDesk(desk.key, String(input.question)),
}));

/**
 * The write tools sit with the manager rather than the desks. Only the person
 * you are actually talking to can change your records, which makes the blast
 * radius of a confused lookup agent exactly zero.
 */
const writeTools: AgentTool[] = [
  findClient,
  logInteraction,
  createAction,
  completeAction,
  upsertClient,
  addFamilyMember,
  createOpportunity,
];

const managerTools: AgentTool[] = [...delegateTools, ...writeTools];

// ---------------------------------------------------------------------------
// The manager's brief
// ---------------------------------------------------------------------------

function managerBrief(): string {
  const roster = DESKS.map((d) => `  - ask_${d.key}: ${d.title}`).join("\n");

  return `You are the practice manager for a licensed financial services
consultant in Singapore. They are your only contact. They reach you by Telegram,
usually on the move -- between appointments, in a lift, driving home from a
client's flat.

You run five desks. You are the only one who talks to the adviser:

${roster}

HOW YOU WORK

Delegate rather than guess. If a question touches birthdays, policies, who to
see, past conversations or product wording, ask the desk that owns it. Ask
several at once when a question spans desks -- "brief me on Sarah before my
2pm" wants the relationship desk and the policy desk in parallel, not one after
the other.

Answer in one voice. The adviser hired a manager, not a switchboard. Never say
"the policy desk reports that". Just tell them the answer.

FILING WHAT THEY TELL YOU

Half of what arrives is not a question, it is a debrief. "Just saw Mr Tan, wife
expecting in March, worried about his SA top-up." When that happens:

  1. find_client to identify who they mean. If two people match, ask which.
  2. log_interaction with a summary in their own words, not your tidier version.
  3. add_family_member for anyone new who was mentioned.
  4. create_action_item for anything they implied they would do.
  5. create_opportunity for something worth revisiting later rather than now.

Then confirm briefly what you filed. One line. They are driving.

If you genuinely cannot tell who they mean, ask. One short question, then file
it once they answer. Never invent a client to attach a note to.

HOW YOU WRITE

This is Telegram, not a report. Short paragraphs, no headers, no bullet lists
unless you are genuinely listing things. Two or three sentences is usually
right. A morning briefing may run longer.

Write the way a good colleague talks: direct, warm, no filler. Never open with
"Certainly" or "I'd be happy to". Just answer.

Use their vocabulary. Shield plan, CI, ILP, SA top-up, AV, MDRT, orphan case.
Do not explain terms they use professionally every day.

Singapore formatting: dollar amounts as $1,250; dates as 18 Sep; day names for
anything inside a fortnight.

WHERE YOUR AUTHORITY ENDS

You are back-office support to a licensed representative. You never recommend a
specific product, never assess suitability, never tell them what a client should
buy. You surface facts, gaps and timing. They advise -- that is what their
licence is for and what their compliance team will hold them to.

Never state a policy number, premium, sum assured or product term you have not
had back from a desk. If you do not have it, say so. A number that turns out to
be wrong in front of a client is far more costly than an admission that you need
to check.

NRIC and FIN numbers are deliberately not stored anywhere in this system. Never
ask for one, never repeat one.

Today is ${sgNow()} in Singapore.`;
}

// ---------------------------------------------------------------------------
// Conversation memory
// ---------------------------------------------------------------------------

const HISTORY_TURNS = 12;

async function loadHistory(chatId: number): Promise<
  Array<{ role: "user" | "assistant"; content: string }>
> {
  const { data, error } = await db()
    .from("conversation_turns")
    .select("role, content")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(HISTORY_TURNS);

  if (error) {
    console.error("could not load history", error.message);
    return [];   // a forgetful manager still beats a broken one
  }

  return (data ?? [])
    .reverse()
    .map((r) => ({ role: r.role as "user" | "assistant", content: r.content }));
}

async function saveTurn(
  chatId: number,
  role: "user" | "assistant",
  content: string,
): Promise<void> {
  const { error } = await db()
    .from("conversation_turns")
    .insert({ chat_id: chatId, role, content });
  if (error) console.error("could not save turn", error.message);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface ManagerReply {
  text: string;
  costUsd: number;
  desksConsulted: string[];
}

/** Handle one message from the adviser and produce the manager's reply. */
export async function handleMessage(
  chatId: number,
  message: string,
): Promise<ManagerReply> {
  const history = await loadHistory(chatId);

  try {
    const result = await runAgent({
      agent: "manager",
      system: managerBrief(),
      messages: [...history, { role: "user", content: message }],
      tools: managerTools,
      model: config.managerModel,
      effort: "medium",
      maxTokens: 8000,
      maxIterations: 10,
    });

    // Save both sides together, so history never ends on a dangling question.
    await saveTurn(chatId, "user", message);
    await saveTurn(chatId, "assistant", result.text);

    return {
      text: result.text,
      costUsd: result.costUsd,
      desksConsulted: [...new Set(
        result.toolsUsed.filter((t) => t.startsWith("ask_")).map((t) => t.slice(4)),
      )],
    };
  } catch (e) {
    if (e instanceof BudgetExceededError) {
      return {
        text:
          `I've hit today's spending limit (US$${e.cap.toFixed(2)}), so I've stopped ` +
          `to avoid surprising you.\n\nYour scheduled alerts still work — those cost ` +
          `nothing. The limit resets at midnight, and you can raise it in Supabase ` +
          `under <code>app_settings</code>.`,
        costUsd: 0,
        desksConsulted: [],
      };
    }
    throw e;
  }
}

// ===== _shared/ingest.ts ===========================================
/**
 * ingest.ts -- taking in files.
 *
 * Two kinds arrive by Telegram:
 *   - A spreadsheet export from the company portal (.csv / .xlsx). Parsed,
 *     staged, and shown to you BEFORE anything touches your client list.
 *   - A product document (.pdf / .txt / .md). Stored, split and indexed so the
 *     product desk can quote from it.
 *
 * The staging step matters. A bad import that silently overwrites two hundred
 * client records is much worse than one that asks a question first.
 */






// ---------------------------------------------------------------------------
// Column mapping
//
// Portal exports name their columns differently at every insurer, so rather
// than demanding one exact format, we recognise the common spellings. Anything
// unrecognised is reported back to you rather than silently dropped.
// ---------------------------------------------------------------------------

const COLUMN_ALIASES: Record<string, string[]> = {
  full_name: [
    "name", "client name", "clientname", "insured name", "policyholder",
    "policy holder", "owner name", "life assured", "full name", "customer name",
  ],
  dob: ["dob", "date of birth", "birth date", "birthdate", "d.o.b"],
  gender: ["gender", "sex"],
  phone: ["phone", "mobile", "contact", "contact no", "handphone", "hp", "tel"],
  email: ["email", "e-mail", "email address"],
  occupation: ["occupation", "job", "job title", "profession"],
  insurer: ["insurer", "company", "carrier", "principal", "provider"],
  plan_name: ["plan", "plan name", "product", "product name", "policy name", "basic plan"],
  policy_number: ["policy number", "policy no", "policy no.", "policyno", "contract number", "cert no"],
  policy_type: ["type", "policy type", "product type", "category"],
  status: ["status", "policy status", "contract status"],
  sum_assured: ["sum assured", "sa", "coverage", "benefit amount", "face amount"],
  premium_amount: ["premium", "premium amount", "modal premium", "gross premium", "annual premium"],
  premium_mode: ["mode", "premium mode", "payment mode", "frequency", "billing frequency"],
  inception_date: [
    "inception date", "inception", "commencement date", "issue date",
    "start date", "policy date", "effective date", "risk commencement date",
  ],
  maturity_date: ["maturity date", "maturity", "expiry date", "end date"],
  next_premium_due: ["next due", "next premium due", "due date", "next payment date", "paid to date"],
};

function normaliseHeader(header: string): string {
  return header.toLowerCase().trim().replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The alias lists are written the way a human would type them ("d.o.b",
 * "policy no."), so they have to go through the same normalisation as the
 * incoming header before being compared. Comparing a normalised header against
 * a raw alias silently fails to match, which means a real column gets ignored.
 */
const NORMALISED_ALIASES: Record<string, string[]> = Object.fromEntries(
  Object.entries(COLUMN_ALIASES).map(([field, aliases]) => [
    field,
    aliases.map(normaliseHeader),
  ]),
);

/** Work out which spreadsheet column means what. */
export function mapColumns(headers: string[]): { mapping: Record<string, string>; unmapped: string[] } {
  const mapping: Record<string, string> = {};
  const unmapped: string[] = [];

  for (const header of headers) {
    const key = normaliseHeader(header);
    let matched = false;

    for (const [field, aliases] of Object.entries(NORMALISED_ALIASES)) {
      if (aliases.includes(key)) {
        // First column wins, so a sheet with both "Name" and "Client Name"
        // does not silently flip between them.
        if (!Object.values(mapping).includes(field)) {
          mapping[header] = field;
        }
        matched = true;
        break;
      }
    }
    if (!matched) unmapped.push(header);
  }

  return { mapping, unmapped };
}

// ---------------------------------------------------------------------------
// Value parsing
// ---------------------------------------------------------------------------

/** Dates arrive as dd/mm/yyyy, yyyy-mm-dd, Excel serials, and more besides. */
export function parseDate(value: unknown): string | null {
  if (value == null || value === "") return null;

  // Excel stores dates as days since 1899-12-30.
  if (typeof value === "number" && value > 20000 && value < 60000) {
    const ms = (value - 25569) * 86400 * 1000;
    return new Date(ms).toISOString().slice(0, 10);
  }

  const text = String(value).trim();

  // Already ISO.
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);

  // dd/mm/yyyy or dd-mm-yyyy. Singapore convention is day first, which matters:
  // reading 03/04/2024 as March would put a birthday a month out.
  const dmy = text.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    const year = y.length === 2 ? `20${y}` : y;
    const day = d.padStart(2, "0");
    const month = m.padStart(2, "0");
    if (Number(month) > 12) return null;   // clearly not day-first; refuse to guess
    return `${year}-${month}-${day}`;
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

export function parseMoney(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number") return value;
  const cleaned = String(value).replace(/[$,\s]/g, "");
  const n = Number(cleaned);
  return Number.isNaN(n) ? null : n;
}

export function parseMode(value: unknown): string | null {
  if (!value) return null;
  const v = String(value).toLowerCase().trim();
  if (/month|mth|\bm\b/.test(v)) return "monthly";
  if (/quarter|qtr|\bq\b/.test(v)) return "quarterly";
  if (/semi|half|\bs\b/.test(v)) return "semi_annual";
  if (/ann|year|yr|\ba\b/.test(v)) return "annual";
  if (/single|lump/.test(v)) return "single";
  return null;
}

export function parseStatus(value: unknown): string {
  if (!value) return "in_force";
  const v = String(value).toLowerCase().trim();
  if (/lapse/.test(v)) return "lapsed";
  if (/paid.?up/.test(v)) return "paid_up";
  if (/matur/.test(v)) return "matured";
  if (/surrend/.test(v)) return "surrendered";
  if (/cancel|terminat/.test(v)) return "cancelled";
  if (/pending|underwrit|uw/.test(v)) return "pending_uw";
  if (/claim/.test(v)) return "claim_paid";
  return "in_force";
}

export function parsePolicyType(value: unknown): string | null {
  if (!value) return null;
  const v = String(value).toLowerCase();
  if (/term/.test(v)) return "term_life";
  if (/whole/.test(v)) return "whole_life";
  if (/endow|savings/.test(v)) return "endowment";
  if (/ilp|invest.?link|unit.?link/.test(v)) return "ilp";
  if (/critical|ci\b|dread/.test(v)) return "ci_standalone";
  if (/shield|hospital|medical|health|shield/.test(v)) return "hospital";
  if (/annuit|retire/.test(v)) return "annuity";
  if (/accident|pa\b/.test(v)) return "accident";
  if (/disab|income/.test(v)) return "disability";
  if (/rider/.test(v)) return "rider";
  return "other";
}

// ---------------------------------------------------------------------------
// Spreadsheet import
// ---------------------------------------------------------------------------

interface StagedRow {
  full_name: string;
  client_fields: Record<string, unknown>;
  policy_fields: Record<string, unknown>;
  has_policy: boolean;
  /**
   * Columns from the export that had no matching field. Kept rather than
   * dropped: the schema is a considered guess at what your principal's export
   * contains, and silently discarding a column you rely on is the worst way to
   * be wrong about that.
   */
  extra: Record<string, unknown>;
}

function parseSheet(bytes: Uint8Array): {
  rows: StagedRow[];
  mapping: Record<string, string>;
  unmapped: string[];
  headers: string[];
} {
  const workbook = XLSX.read(bytes, { type: "array", cellDates: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("That file has no sheets in it.");

  const sheet = workbook.Sheets[sheetName];
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null });
  if (raw.length === 0) throw new Error("That sheet is empty.");

  const headers = Object.keys(raw[0]);
  const { mapping, unmapped } = mapColumns(headers);

  if (!Object.values(mapping).includes("full_name")) {
    throw new Error(
      "I can't find a name column. I looked for: " +
      COLUMN_ALIASES.full_name.join(", "),
    );
  }

  const rows: StagedRow[] = [];

  for (const record of raw) {
    const mapped: Record<string, unknown> = {};
    for (const [header, field] of Object.entries(mapping)) {
      mapped[field] = record[header];
    }

    const name = String(mapped.full_name ?? "").trim();
    if (!name) continue;   // a row with no name is not a client

    // Anything we did not recognise, kept verbatim under its original header.
    const extra: Record<string, unknown> = {};
    for (const header of unmapped) {
      const value = record[header];
      if (value !== null && value !== undefined && value !== "") {
        extra[header] = typeof value === "string" ? scrubNric(value) : value;
      }
    }

    const client_fields: Record<string, unknown> = {
      full_name: scrubNric(name),
      dob: parseDate(mapped.dob),
      phone: mapped.phone ? String(mapped.phone).trim() : null,
      email: mapped.email ? String(mapped.email).trim() : null,
      occupation: mapped.occupation ? scrubNric(String(mapped.occupation)) : null,
      gender: mapped.gender
        ? (String(mapped.gender).toUpperCase().startsWith("M") ? "M"
          : String(mapped.gender).toUpperCase().startsWith("F") ? "F" : null)
        : null,
    };

    const policyNumber = mapped.policy_number ? String(mapped.policy_number).trim() : null;
    const planName = mapped.plan_name ? String(mapped.plan_name).trim() : null;
    const has_policy = Boolean(policyNumber || planName);

    const policy_fields: Record<string, unknown> = has_policy
      ? {
        insurer: mapped.insurer ? String(mapped.insurer).trim() : "Unknown",
        plan_name: planName ?? "Unnamed plan",
        policy_number: policyNumber,
        policy_type: parsePolicyType(mapped.policy_type ?? planName),
        status: parseStatus(mapped.status),
        sum_assured: parseMoney(mapped.sum_assured),
        premium_amount: parseMoney(mapped.premium_amount),
        premium_mode: parseMode(mapped.premium_mode),
        inception_date: parseDate(mapped.inception_date),
        maturity_date: parseDate(mapped.maturity_date),
        next_premium_due: parseDate(mapped.next_premium_due),
      }
      : {};

    rows.push({
      full_name: client_fields.full_name as string,
      client_fields, policy_fields, has_policy, extra,
    });
  }

  return { rows, mapping, unmapped, headers };
}

async function stageSpreadsheet(
  chatId: number,
  doc: TelegramDocument,
  bytes: Uint8Array,
): Promise<void> {
  const { rows, mapping, unmapped } = parseSheet(bytes);

  if (rows.length === 0) {
    await sendMessage(chatId, "I read the file but found no rows with a name in them.");
    return;
  }

  const withPolicy = rows.filter((r) => r.has_policy).length;
  const uniqueNames = new Set(rows.map((r) => r.full_name.toLowerCase()));

  const { data, error } = await db()
    .from("import_batches")
    .insert({
      chat_id: chatId,
      source_filename: doc.file_name ?? "upload",
      kind: withPolicy > 0 ? "mixed" : "clients",
      row_count: rows.length,
      parsed_rows: rows,
      column_mapping: mapping,
      summary: `${rows.length} rows, ${uniqueNames.size} distinct names, ${withPolicy} with policy details`,
    })
    .select("id")
    .single();

  if (error) throw new Error(`Could not stage the import: ${error.message}`);

  const recognised = Object.entries(mapping)
    .map(([header, field]) => `  ${esc(header)} → ${field}`)
    .join("\n");

  const ignored = unmapped.length > 0
    ? `\n\n<b>Columns I did not recognise</b>\n` +
      unmapped.map((u) => `  ${esc(u)}`).join("\n") +
      `\n\n<i>These are kept anyway, stored against each record and visible in ` +
      `the portal. Nothing is lost. Send me this list and they can be given ` +
      `proper columns.</i>`
    : "";

  await sendMessage(
    chatId,
    `📄 <b>${esc(doc.file_name ?? "Import")}</b>\n\n` +
    `${rows.length} rows · ${uniqueNames.size} distinct people · ${withPolicy} with policy details\n\n` +
    `<b>Columns I recognised</b>\n${recognised}${ignored}\n\n` +
    `Nothing has been saved yet. Reply <code>/apply ${data.id.slice(0, 8)}</code> to ` +
    `bring this in, or just ignore it and it stays staged.\n\n` +
    `<i>Existing clients are matched by name and updated rather than duplicated. ` +
    `Policies are matched by insurer and policy number.</i>`,
  );
}

/**
 * Apply a staged import. Matches on name for clients and on insurer + policy
 * number for policies, so re-importing next month updates rather than duplicates.
 */
export async function applyImport(chatId: number, batchPrefix: string): Promise<void> {
  const { data: batches, error } = await db()
    .from("import_batches")
    .select("*")
    .eq("chat_id", chatId)
    .eq("status", "staged")
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) throw new Error(error.message);

  const batch = (batches ?? []).find((b) => String(b.id).startsWith(batchPrefix));
  if (!batch) {
    await sendMessage(chatId, `I can't find a staged import starting <code>${esc(batchPrefix)}</code>.`);
    return;
  }

  const rows = batch.parsed_rows as StagedRow[];
  let clientsCreated = 0, clientsUpdated = 0, policiesCreated = 0, policiesUpdated = 0;
  const problems: string[] = [];

  for (const row of rows) {
    try {
      // --- client ---
      const { data: existing } = await db()
        .from("clients")
        .select("id")
        .ilike("full_name", row.full_name)
        .limit(1)
        .maybeSingle();

      const fields: Record<string, unknown> = Object.fromEntries(
        Object.entries(row.client_fields).filter(([, v]) => v != null && v !== ""),
      );

      // Leftovers belong with whichever record the row is really about.
      const hasExtra = Object.keys(row.extra ?? {}).length > 0;
      if (hasExtra && !row.has_policy) fields.extra = row.extra;

      let clientId: string;
      if (existing) {
        clientId = existing.id;
        // Only fill blanks on update. A portal export should not overwrite a
        // phone number you corrected by hand last week.
        const { data: current } = await db()
          .from("clients").select("*").eq("id", clientId).single();

        const toFill: Record<string, unknown> = Object.fromEntries(
          Object.entries(fields).filter(([k]) => k !== "extra" && current?.[k] == null),
        );
        // Merge extras rather than replace, so a narrower export next month
        // does not erase what a wider one captured.
        if (fields.extra) {
          toFill.extra = { ...(current?.extra ?? {}), ...(fields.extra as object) };
        }
        if (Object.keys(toFill).length > 0) {
          await db().from("clients").update(toFill).eq("id", clientId);
        }
        clientsUpdated += 1;
      } else {
        const { data: created, error: createError } = await db()
          .from("clients").insert(fields).select("id").single();
        if (createError) throw new Error(createError.message);
        clientId = created.id;
        clientsCreated += 1;
      }

      // --- policy ---
      if (row.has_policy) {
        const pf: Record<string, unknown> = { ...row.policy_fields, client_id: clientId };
        if (Object.keys(row.extra ?? {}).length > 0) pf.extra = row.extra;
        const policyNumber = pf.policy_number as string | null;

        if (policyNumber) {
          const { data: existingPolicy } = await db()
            .from("policies")
            .select("id")
            .eq("insurer", String(pf.insurer))
            .eq("policy_number", policyNumber)
            .maybeSingle();

          if (existingPolicy) {
            const updates = Object.fromEntries(
              Object.entries(pf).filter(([, v]) => v != null && v !== ""),
            );
            await db().from("policies").update(updates).eq("id", existingPolicy.id);
            policiesUpdated += 1;
            continue;
          }
        }

        const { error: policyError } = await db().from("policies").insert(pf);
        if (policyError) throw new Error(policyError.message);
        policiesCreated += 1;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      problems.push(`${row.full_name}: ${msg}`);
    }
  }

  await db()
    .from("import_batches")
    .update({ status: problems.length === rows.length ? "failed" : "applied", applied_at: new Date().toISOString() })
    .eq("id", batch.id);

  const problemBlock = problems.length > 0
    ? `\n\n<b>${problems.length} row(s) had trouble</b>\n` +
      problems.slice(0, 8).map((p) => `  • ${esc(p)}`).join("\n") +
      (problems.length > 8 ? `\n  …and ${problems.length - 8} more` : "")
    : "";

  await sendMessage(
    chatId,
    `✅ <b>Import applied</b>\n\n` +
    `Clients: ${clientsCreated} new, ${clientsUpdated} matched\n` +
    `Policies: ${policiesCreated} new, ${policiesUpdated} updated` +
    problemBlock,
  );
}

// ---------------------------------------------------------------------------
// Product documents
// ---------------------------------------------------------------------------

/**
 * Split on blank lines, then pack into chunks of roughly 1,200 characters with
 * a little overlap. Paragraph boundaries keep a benefit table or an exclusion
 * clause intact rather than cut in half, which matters a great deal when the
 * product desk is quoting the result back to you.
 */
export function chunkText(text: string, target = 1200, overlap = 150): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > target && current.length > 0) {
      chunks.push(current);
      current = current.slice(-overlap) + "\n\n" + para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }
  if (current.trim()) chunks.push(current);

  return chunks.filter((c) => c.trim().length > 50);   // drop page-furniture fragments
}

async function ingestProductDocument(
  chatId: number,
  doc: TelegramDocument,
  bytes: Uint8Array,
  caption?: string,
): Promise<void> {
  const filename = doc.file_name ?? "document.pdf";

  // The caption is how you tell me what this is: "AIA Max VitalHealth A"
  const label = (caption ?? filename.replace(/\.[^.]+$/, "")).trim();
  const insurerGuess = label.split(/\s+/)[0] ?? "Unknown";

  let text = "";
  let pageCount: number | null = null;

  if (filename.toLowerCase().endsWith(".pdf") || doc.mime_type === "application/pdf") {
    const pdf = await getDocumentProxy(bytes);
    pageCount = pdf.numPages;
    const result = await extractText(pdf, { mergePages: true });
    text = Array.isArray(result.text) ? result.text.join("\n\n") : result.text;
  } else {
    text = new TextDecoder().decode(bytes);
  }

  text = scrubNric(text.replace(/\r/g, ""));

  if (text.trim().length < 200) {
    await sendMessage(
      chatId,
      `I could not read useful text out of <b>${esc(filename)}</b>.\n\n` +
      `<i>If it is a scanned document, the pages are images rather than text — ` +
      `that needs OCR, which is not set up here. A text-based PDF from the ` +
      `insurer's website will work.</i>`,
    );
    return;
  }

  // Keep the original, so a better parser later can re-read it.
  const storagePath = `${Date.now()}-${filename}`;
  const { error: uploadError } = await db().storage
    .from("products")
    .upload(storagePath, bytes, {
      contentType: doc.mime_type ?? "application/pdf",
      upsert: false,
    });
  if (uploadError) console.error("storage upload failed:", uploadError.message);

  const { data: product, error: productError } = await db()
    .from("products")
    .insert({
      insurer: insurerGuess,
      name: label,
      doc_type: /contract|policy.?doc|terms/i.test(filename)
        ? "policy_contract"
        : /brochure/i.test(filename)
        ? "brochure"
        : "product_summary",
      storage_path: uploadError ? null : storagePath,
      source_filename: filename,
      page_count: pageCount,
      ingested_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (productError) throw new Error(`Could not record the document: ${productError.message}`);

  const chunks = chunkText(text);
  const records = chunks.map((content, i) => ({
    product_id: product.id,
    chunk_index: i,
    content,
  }));

  // Insert in batches; a long contract can run to hundreds of chunks.
  for (let i = 0; i < records.length; i += 100) {
    const { error } = await db().from("product_chunks").insert(records.slice(i, i + 100));
    if (error) throw new Error(`Could not index the document: ${error.message}`);
  }

  await sendMessage(
    chatId,
    `📚 <b>Added to the library</b>\n\n` +
    `${esc(label)}\n` +
    `${pageCount ? `${pageCount} pages · ` : ""}${chunks.length} searchable sections\n\n` +
    `I filed it under insurer <b>${esc(insurerGuess)}</b>. If that's wrong, tell me ` +
    `and I'll correct it.\n\n` +
    `<i>Ask me about it any time — I'll quote the document rather than answer ` +
    `from memory.</i>`,
  );
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function handleDocument(
  chatId: number,
  doc: TelegramDocument,
  caption?: string,
): Promise<void> {
  const filename = (doc.file_name ?? "").toLowerCase();

  try {
    const bytes = await downloadFile(doc.file_id);

    if (/\.(csv|xlsx|xls)$/.test(filename)) {
      await stageSpreadsheet(chatId, doc, bytes);
      return;
    }

    if (/\.(pdf|txt|md)$/.test(filename)) {
      await ingestProductDocument(chatId, doc, bytes, caption);
      return;
    }

    await sendMessage(
      chatId,
      `I don't know what to do with <b>${esc(doc.file_name ?? "that")}</b>.\n\n` +
      `Send me a <code>.csv</code> or <code>.xlsx</code> export to update client ` +
      `records, or a <code>.pdf</code> product document for the library.`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("document ingest failed:", msg);
    await sendMessage(chatId, `That file gave me trouble.\n\n<code>${esc(msg)}</code>`);
  }
}

// ===== telegram/index.ts ===========================================
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
