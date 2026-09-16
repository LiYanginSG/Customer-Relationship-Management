/**
 * Tests for the NRIC guard.
 *
 * The brief was explicit: everything else is fine, but no NRIC. This is
 * enforced twice -- by a database trigger on write, and by these functions on
 * every path out of the system. These tests cover the second layer.
 */

import { assert, assertEquals } from "jsr:@std/assert@1";
import { scrubNric, containsNric, scrubDeep } from "../supabase/functions/_shared/nric.ts";

Deno.test("all five NRIC and FIN prefixes are caught", () => {
  for (const prefix of ["S", "T", "F", "G", "M"]) {
    const id = `${prefix}1234567D`;
    assert(containsNric(id), `${id} should be detected`);
    assertEquals(scrubNric(id), "[NRIC-REMOVED]");
  }
});

Deno.test("lowercase NRICs are caught too", () => {
  assertEquals(scrubNric("s1234567d"), "[NRIC-REMOVED]");
});

Deno.test("an NRIC embedded in a sentence is removed, the sentence survives", () => {
  assertEquals(
    scrubNric("His IC is S1234567D and he lives in Punggol."),
    "His IC is [NRIC-REMOVED] and he lives in Punggol.",
  );
});

Deno.test("several NRICs in one block of text are all removed", () => {
  const out = scrubNric("Client S1234567D, spouse T7654321J, helper G1112223X");
  assertEquals(containsNric(out), false);
  assertEquals(out.match(/\[NRIC-REMOVED\]/g)?.length, 3);
});

Deno.test("ordinary text that merely looks similar is left alone", () => {
  // Policy numbers and plan codes must not be mangled -- losing a policy
  // number would be its own kind of data loss.
  const safe = [
    "Policy POL-12345678",
    "Plan S123456 (six digits, not seven)",
    "Reference AB1234567C",       // two letters up front, not an NRIC
    "Amount $1234567",
  ];
  for (const text of safe) {
    assertEquals(scrubNric(text), text, `should not alter: ${text}`);
  }
});

Deno.test("scrubDeep reaches through nested objects and arrays", () => {
  const row = {
    name: "Tan Wei Ming",
    notes: "IC S1234567D on file",
    policies: [
      { number: "POL-1", note: "spouse T7654321J" },
      { number: "POL-2", note: null },
    ],
    meta: { nested: { deep: "G1112223X" } },
    count: 3,
    flag: true,
  };

  const cleaned = scrubDeep(row);

  assertEquals(cleaned.notes, "IC [NRIC-REMOVED] on file");
  assertEquals(cleaned.policies[0].note, "spouse [NRIC-REMOVED]");
  assertEquals(cleaned.meta.nested.deep, "[NRIC-REMOVED]");
  // Non-string values must come through untouched.
  assertEquals(cleaned.count, 3);
  assertEquals(cleaned.flag, true);
  assertEquals(cleaned.policies[1].note, null);
});

Deno.test("containsNric does not get confused by repeated calls", () => {
  // A global regex carries lastIndex between calls; forgetting to reset it
  // makes every second call return the wrong answer.
  const id = "S1234567D";
  assertEquals(containsNric(id), true);
  assertEquals(containsNric(id), true);
  assertEquals(containsNric(id), true);
});
