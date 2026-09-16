/**
 * Tests for the briefing formatter.
 *
 * These run without a database or an API key: the formatter is pure, so it can
 * be fed fixed data and checked. The fixtures below were captured from a real
 * Postgres run of build_daily_briefing(), so the shapes are genuine rather
 * than invented.
 *
 * Run with:  deno test --allow-env tests/
 */

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

// The formatter reads config at import time, which requires these two.
Deno.env.set("SUPABASE_URL", "http://localhost");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-key-not-real");

const { formatBriefing } = await import("../supabase/functions/_shared/briefing.ts");
type Briefing = Parameters<typeof formatBriefing>[0];

const EMPTY: NonNullable<Briefing> = {
  generated_for: "2026-09-16",
  birthdays: [],
  premiums_due: [],
  anniversaries: [],
  gone_quiet: [],
  actions_due: [],
  counts: { clients: 0, policies_in_force: 0, open_actions: 0, overdue_actions: 0 },
};

Deno.test("a genuinely quiet day sends nothing on a weekday", () => {
  // A bot that says "nothing today" every morning gets muted, and a muted bot
  // is useless on the day something does matter.
  assertEquals(formatBriefing(EMPTY, "morning"), null);
});

Deno.test("a quiet week still gets the Sunday note", () => {
  const out = formatBriefing(EMPTY, "week_ahead");
  assert(out !== null);
  assertStringIncludes(out, "Nothing pressing");
});

Deno.test("an overdue premium is called out as a lapse risk, before anything else", () => {
  const out = formatBriefing({
    ...EMPTY,
    premiums_due: [{
      client_name: "Sarah Lim", display_name: "Sarah", insurer: "Great Eastern",
      plan_name: "GREAT Term", premium_amount: 1200, premium_mode: "annual",
      next_premium_due: "2026-09-10", days_away: -6, paid_from_cpf: false,
    }],
    birthdays: [{
      client_id: "x", client_name: "Tan Wei Ming", display_name: "Wei Ming",
      whose: "client", relationship: null, next_birthday: "2026-09-19",
      days_away: 3, turning: 41, client_status: "active", last_contacted_at: null,
    }],
    counts: { ...EMPTY.counts, clients: 2, policies_in_force: 1 },
  }, "morning");

  assert(out !== null);
  assertStringIncludes(out, "lapse risk");
  assertStringIncludes(out, "6 days late");
  assertStringIncludes(out, "$1,200");
  // Money before birthdays: the urgent thing has to be at the top.
  assert(out.indexOf("lapse risk") < out.indexOf("Birthdays"));
});

Deno.test("CPF-funded premiums say so, because they fail differently", () => {
  const out = formatBriefing({
    ...EMPTY,
    premiums_due: [{
      client_name: "Jason Koh", display_name: "Jason", insurer: "Prudential",
      plan_name: "PRUShield", premium_amount: 380, premium_mode: "annual",
      next_premium_due: "2026-09-10", days_away: -2, paid_from_cpf: true,
    }],
  }, "morning");

  assert(out !== null);
  assertStringIncludes(out, "CPF-funded");
});

Deno.test("milestone ages are flagged, ordinary ages are not", () => {
  const at = (turning: number) =>
    formatBriefing({
      ...EMPTY,
      birthdays: [{
        client_id: "x", client_name: "A B", display_name: "A", whose: "client",
        relationship: null, next_birthday: "2026-09-19", days_away: 2,
        turning, client_status: "active", last_contacted_at: null,
      }],
    }, "morning") ?? "";

  assertStringIncludes(at(55), "CPF Retirement Account");
  assertStringIncludes(at(65), "CPF LIFE");
  assertStringIncludes(at(21), "ages out");
  assert(!at(43).includes("—  "), "43 is not a milestone and should carry no note");
});

Deno.test("a family birthday names whose it is", () => {
  const out = formatBriefing({
    ...EMPTY,
    birthdays: [{
      client_id: "x", client_name: "Sarah Lim", display_name: "Anya",
      whose: "family", relationship: "child", next_birthday: "2026-09-21",
      days_away: 5, turning: 6, client_status: "active", last_contacted_at: null,
    }],
  }, "morning");

  assert(out !== null);
  assertStringIncludes(out, "Anya");
  assertStringIncludes(out, "Sarah Lim's child");
});

Deno.test("a birthday for someone long out of contact carries the warning", () => {
  const longAgo = new Date(Date.now() - 200 * 86400000).toISOString();
  const out = formatBriefing({
    ...EMPTY,
    birthdays: [{
      client_id: "x", client_name: "Tan Wei Ming", display_name: "Wei Ming",
      whose: "client", relationship: null, next_birthday: "2026-09-19",
      days_away: 3, turning: 41, client_status: "active",
      last_contacted_at: longAgo,
    }],
  }, "morning");

  assert(out !== null);
  assertStringIncludes(out, "no contact in");
});

Deno.test("counts are pluralised properly", () => {
  const out = formatBriefing({
    ...EMPTY,
    birthdays: [{
      client_id: "x", client_name: "A B", display_name: "A", whose: "client",
      relationship: null, next_birthday: "2026-09-19", days_away: 1,
      turning: 40, client_status: "active", last_contacted_at: null,
    }],
    counts: { clients: 1, policies_in_force: 1, open_actions: 1, overdue_actions: 0 },
  }, "morning");

  assert(out !== null);
  assertStringIncludes(out, "1 client ·");
  assertStringIncludes(out, "1 policy in force");
  assertStringIncludes(out, "1 open follow-up<");
});

Deno.test("the export reminder does not invent urgency", () => {
  const out = formatBriefing(null, "export_reminder");
  assert(out !== null);
  assertStringIncludes(out, "Monthly export");
  // It must keep telling him not to automate the portal login.
  assertStringIncludes(out, "credentials");
});
