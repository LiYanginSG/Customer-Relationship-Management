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
