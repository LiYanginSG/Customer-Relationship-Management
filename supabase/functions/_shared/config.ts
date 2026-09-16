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
