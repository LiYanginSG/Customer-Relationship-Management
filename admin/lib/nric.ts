/**
 * nric.ts -- the portal's copy of the NRIC guard.
 *
 * The database strips NRICs on write via trigger, so this is belt and braces
 * for anything typed into a form. Catching it here means the adviser sees the
 * warning immediately rather than discovering later that their note was
 * silently altered.
 */

const NRIC_PATTERN = /\b[STFGMstfgm]\d{7}[A-Za-z]\b/g;

export function containsNric(text: string): boolean {
  NRIC_PATTERN.lastIndex = 0;
  return NRIC_PATTERN.test(text);
}

export function scrubNric(text: string): string {
  return text.replace(NRIC_PATTERN, "[NRIC-REMOVED]");
}

/** Check every free-text field of a form submission at once. */
export function formHasNric(data: FormData): boolean {
  for (const value of data.values()) {
    if (typeof value === "string" && containsNric(value)) return true;
  }
  return false;
}
