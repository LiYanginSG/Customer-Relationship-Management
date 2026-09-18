/** Display helpers. Singapore conventions throughout. */

const TZ = "Asia/Singapore";

export function sgToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ });
}

export function formatDate(date: string | null | undefined): string {
  if (!date) return "—";
  const d = new Date(`${date}T00:00:00+08:00`);
  if (Number.isNaN(d.getTime())) return String(date);
  return d.toLocaleDateString("en-SG", {
    timeZone: TZ, day: "numeric", month: "short", year: "numeric",
  });
}

export function formatDateShort(date: string | null | undefined): string {
  if (!date) return "—";
  const d = new Date(`${date}T00:00:00+08:00`);
  if (Number.isNaN(d.getTime())) return String(date);
  return d.toLocaleDateString("en-SG", { timeZone: TZ, day: "numeric", month: "short" });
}

export function formatDateTime(ts: string | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleString("en-SG", {
    timeZone: TZ, day: "numeric", month: "short", year: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

export function money(amount: number | string | null | undefined): string {
  if (amount == null || amount === "") return "—";
  const n = Number(amount);
  if (Number.isNaN(n)) return String(amount);
  return `$${n.toLocaleString("en-SG", {
    minimumFractionDigits: n % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

export function relativeDays(days: number | null | undefined): string {
  if (days == null) return "";
  const n = Number(days);
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n === -1) return "yesterday";
  if (n < 0) return `${Math.abs(n)} days ago`;
  return `in ${n} days`;
}

/** Age today, from a date of birth. */
export function age(dob: string | null | undefined): number | null {
  if (!dob) return null;
  const birth = new Date(`${dob}T00:00:00+08:00`);
  if (Number.isNaN(birth.getTime())) return null;
  const now = new Date();
  let years = now.getFullYear() - birth.getFullYear();
  const monthDiff = now.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < birth.getDate())) years -= 1;
  return years;
}

/** Annualise a premium so different payment modes can be compared. */
export function annualisedPremium(
  amount: number | null | undefined,
  mode: string | null | undefined,
): number {
  const multipliers: Record<string, number> = {
    monthly: 12, quarterly: 4, semi_annual: 2, annual: 1, single: 0, limited_pay: 1,
  };
  return Number(amount ?? 0) * (multipliers[String(mode)] ?? 1);
}

export const PREMIUM_MODES = [
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "semi_annual", label: "Semi-annual" },
  { value: "annual", label: "Annual" },
  { value: "single", label: "Single premium" },
  { value: "limited_pay", label: "Limited pay" },
];

export const POLICY_TYPES = [
  { value: "term_life", label: "Term life" },
  { value: "whole_life", label: "Whole life" },
  { value: "endowment", label: "Endowment" },
  { value: "ilp", label: "ILP" },
  { value: "ci_standalone", label: "Critical illness" },
  { value: "hospital", label: "Hospital / Shield" },
  { value: "rider", label: "Rider" },
  { value: "annuity", label: "Annuity" },
  { value: "accident", label: "Personal accident" },
  { value: "disability", label: "Disability income" },
  { value: "travel", label: "Travel" },
  { value: "motor", label: "Motor" },
  { value: "home", label: "Home" },
  { value: "business", label: "Business" },
  { value: "other", label: "Other" },
];

export const POLICY_STATUSES = [
  { value: "in_force", label: "In force" },
  { value: "lapsed", label: "Lapsed" },
  { value: "paid_up", label: "Paid up" },
  { value: "matured", label: "Matured" },
  { value: "surrendered", label: "Surrendered" },
  { value: "claim_paid", label: "Claim paid" },
  { value: "pending_uw", label: "Pending underwriting" },
  { value: "cancelled", label: "Cancelled" },
];

export const CLIENT_STATUSES = [
  { value: "prospect", label: "Prospect" },
  { value: "active", label: "Active" },
  { value: "dormant", label: "Dormant" },
  { value: "lapsed", label: "Lapsed" },
  { value: "referral_only", label: "Referral only" },
  { value: "former", label: "Former" },
];

export const RESIDENCY = [
  { value: "citizen", label: "Singapore citizen" },
  { value: "pr", label: "Permanent resident" },
  { value: "ep_spass", label: "EP / S Pass" },
  { value: "foreigner", label: "Foreigner" },
  { value: "unknown", label: "Not known" },
];

export const RELATIONSHIPS = [
  { value: "spouse", label: "Spouse" },
  { value: "child", label: "Child" },
  { value: "parent", label: "Parent" },
  { value: "sibling", label: "Sibling" },
  { value: "domestic_partner", label: "Domestic partner" },
  { value: "other", label: "Other" },
];

export const CHANNELS = [
  { value: "meeting", label: "Meeting" },
  { value: "call", label: "Call" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "email", label: "Email" },
  { value: "telegram", label: "Telegram" },
  { value: "event", label: "Event" },
  { value: "note", label: "Note" },
  { value: "other", label: "Other" },
];

/** Turn a stored value back into its human label. */
export function labelFor(
  options: Array<{ value: string; label: string }>,
  value: string | null | undefined,
): string {
  if (!value) return "—";
  return options.find((o) => o.value === value)?.label ?? value;
}

/**
 * Coverage types exactly as an insurer's portfolio summary prints them.
 * Kept verbatim rather than normalised, so a line in the portal reads the same
 * as the line on the statement the client is holding.
 */
export const COVERAGE_TYPES = [
  { value: "Hospitalisation", label: "Hospitalisation" },
  { value: "Death", label: "Death" },
  { value: "Multi-stage CI", label: "Multi-stage CI" },
  { value: "Major CI", label: "Major CI" },
  { value: "TPD", label: "Total permanent disability" },
  { value: "Acc. Death / TPD", label: "Accidental death / TPD" },
  { value: "Acc. Reimbursement", label: "Accidental reimbursement" },
  { value: "Disability Income", label: "Disability income" },
  { value: "Others", label: "Others" },
];

export const NON_CASH_SOURCES = [
  { value: "CPF MediSave", label: "CPF MediSave" },
  { value: "CPF OA", label: "CPF Ordinary Account" },
  { value: "CPF SA", label: "CPF Special Account" },
  { value: "SRS", label: "SRS" },
];

export const PAYMENT_METHODS = [
  { value: "Cash", label: "Cash" },
  { value: "Credit Card", label: "Credit card" },
  { value: "GIRO", label: "GIRO" },
  { value: "Cheque", label: "Cheque" },
  { value: "Bank Transfer", label: "Bank transfer" },
];

/** A policy number an export masked, e.g. ******1556. */
export function isMaskedPolicyNumber(value: string | null | undefined): boolean {
  return Boolean(value && /^[*x\u2022]+\s*\d+$/.test(value.trim()));
}
