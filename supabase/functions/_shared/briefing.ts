/**
 * briefing.ts -- the morning message.
 *
 * Everything here is formatted from a single SQL query. No model is called, no
 * API key is needed, and it costs nothing to run. That is deliberate: the part
 * of this system you rely on every single morning should not have a bill or a
 * dependency on anyone's service being up.
 */

import { rpc } from "./db.ts";
import { esc } from "./telegram.ts";
import { formatShort, money, relativeDays, sgToday } from "./dates.ts";

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
