/**
 * Tests for spreadsheet parsing.
 *
 * Date parsing gets the most attention here because it carries the most risk.
 * Singapore writes dates day-first. Reading 03/04/2024 as 4 March instead of
 * 3 April puts a birthday alert a month out, and puts a premium due date on the
 * wrong side of a lapse. It is the kind of bug that looks like it works until
 * the twelfth of the month.
 */

import { assert, assertEquals } from "jsr:@std/assert@1";

Deno.env.set("SUPABASE_URL", "http://localhost");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-key-not-real");

const {
  parseDate, parseMoney, parseMode, parseStatus, parsePolicyType,
  chunkText, mapColumns,
} = await import("../supabase/functions/_shared/ingest.ts");

Deno.test("dates are read day-first, as Singapore writes them", () => {
  assertEquals(parseDate("03/04/2024"), "2024-04-03");   // 3 April, not 4 March
  assertEquals(parseDate("28/12/1988"), "1988-12-28");
  assertEquals(parseDate("01-02-2020"), "2020-02-01");
});

Deno.test("an ambiguous date with month > 12 is refused rather than guessed", () => {
  // 04/13/2024 can only be month-first, which contradicts the day-first rule.
  // Returning null makes the row visible in the import report instead of
  // silently storing a date that is a year and a month wrong.
  assertEquals(parseDate("04/13/2024"), null);
});

Deno.test("ISO dates pass through untouched", () => {
  assertEquals(parseDate("2024-04-03"), "2024-04-03");
  assertEquals(parseDate("2024-04-03T10:00:00Z"), "2024-04-03");
});

Deno.test("Excel serial numbers are converted", () => {
  // 45000 is 2023-03-15 in Excel's day-count from 1899-12-30.
  assertEquals(parseDate(45000), "2023-03-15");
});

Deno.test("two-digit years are assumed to be this century", () => {
  assertEquals(parseDate("05/06/24"), "2024-06-05");
});

Deno.test("empty and junk dates return null rather than throwing", () => {
  assertEquals(parseDate(null), null);
  assertEquals(parseDate(""), null);
  assertEquals(parseDate("n/a"), null);
});

Deno.test("money survives dollar signs, commas and spaces", () => {
  assertEquals(parseMoney("$1,250.50"), 1250.5);
  assertEquals(parseMoney("1200"), 1200);
  assertEquals(parseMoney(450), 450);
  assertEquals(parseMoney(""), null);
});

Deno.test("premium modes are recognised across the spellings insurers use", () => {
  assertEquals(parseMode("Monthly"), "monthly");
  assertEquals(parseMode("MTH"), "monthly");
  assertEquals(parseMode("Quarterly"), "quarterly");
  assertEquals(parseMode("QTR"), "quarterly");
  assertEquals(parseMode("Semi-Annual"), "semi_annual");
  assertEquals(parseMode("Yearly"), "annual");
  assertEquals(parseMode("Single Premium"), "single");
});

Deno.test("an unrecognised policy status defaults to in force, not to lapsed", () => {
  // Defaulting to lapsed would hide live policies from every premium alert,
  // which is the more dangerous direction to be wrong in.
  assertEquals(parseStatus("something odd"), "in_force");
  assertEquals(parseStatus("Lapsed"), "lapsed");
  assertEquals(parseStatus("Paid-Up"), "paid_up");
  assertEquals(parseStatus(null), "in_force");
});

Deno.test("policy types are inferred from plan names", () => {
  assertEquals(parsePolicyType("PRUShield Premier"), "hospital");
  assertEquals(parsePolicyType("GREAT Term Protect"), "term_life");
  assertEquals(parsePolicyType("Pro Achiever ILP"), "ilp");
  assertEquals(parsePolicyType("Early Critical Illness"), "ci_standalone");
  assertEquals(parsePolicyType("Whole Life Plus"), "whole_life");
});

Deno.test("column headers are matched across the spellings portals use", () => {
  const { mapping, unmapped } = mapColumns([
    "Client Name", "D.O.B", "Policy No.", "Basic Plan",
    "Modal Premium", "Payment Mode", "Commencement Date", "Agent Code",
  ]);

  assertEquals(mapping["Client Name"], "full_name");
  assertEquals(mapping["D.O.B"], "dob");
  assertEquals(mapping["Policy No."], "policy_number");
  assertEquals(mapping["Basic Plan"], "plan_name");
  assertEquals(mapping["Modal Premium"], "premium_amount");
  assertEquals(mapping["Payment Mode"], "premium_mode");
  assertEquals(mapping["Commencement Date"], "inception_date");

  // Unknown columns are reported, not silently dropped.
  assert(unmapped.includes("Agent Code"));
});

Deno.test("a duplicate-meaning column does not overwrite the first one", () => {
  const { mapping } = mapColumns(["Name", "Client Name"]);
  assertEquals(mapping["Name"], "full_name");
  assertEquals(mapping["Client Name"], undefined);
});

Deno.test("document chunking keeps paragraphs whole and drops page furniture", () => {
  const doc = [
    "Benefit Schedule".padEnd(60, " "),
    "A".repeat(900),
    "B".repeat(900),
    "12",                       // a stray page number
  ].join("\n\n");

  const chunks = chunkText(doc);
  assert(chunks.length >= 2, "long text should split");
  assert(chunks.every((c) => c.length > 50), "fragments should be dropped");
  assert(!chunks.includes("12"), "a bare page number is not a searchable section");
});
