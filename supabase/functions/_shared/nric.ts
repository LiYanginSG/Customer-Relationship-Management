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
