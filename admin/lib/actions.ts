"use server";

/**
 * actions.ts -- everything that changes data.
 *
 * Two rules, applied without exception:
 *   - Every action calls requireUser() FIRST. A Server Action is a public HTTP
 *     endpoint; being unreachable from the UI protects nothing.
 *   - Every action returns a plain result rather than throwing, so the form can
 *     show the adviser what went wrong instead of a crash page.
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "./auth";
import { db } from "./db";
import { formHasNric } from "./nric";

export interface ActionResult {
  ok: boolean;
  error?: string;
  message?: string;
}

const NRIC_WARNING =
  "That looks like it contains an NRIC or FIN. This system deliberately stores " +
  "none, so please remove it and save again.";

/** Empty strings from a form mean "not provided", not "set it to blank". */
function text(data: FormData, field: string): string | null {
  const value = data.get(field);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function number(data: FormData, field: string): number | null {
  const value = text(data, field);
  if (value == null) return null;
  const n = Number(value.replace(/[$,\s]/g, ""));
  return Number.isNaN(n) ? null : n;
}

function bool(data: FormData, field: string): boolean {
  return data.get(field) === "on" || data.get(field) === "true";
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

export async function saveClient(
  _prev: ActionResult | null,
  data: FormData,
): Promise<ActionResult> {
  await requireUser();

  if (formHasNric(data)) return { ok: false, error: NRIC_WARNING };

  const fullName = text(data, "full_name");
  if (!fullName) return { ok: false, error: "A name is required." };

  const fields = {
    full_name: fullName,
    preferred_name: text(data, "preferred_name"),
    dob: text(data, "dob"),
    gender: text(data, "gender"),
    marital_status: text(data, "marital_status"),
    residency: text(data, "residency") ?? "unknown",
    occupation: text(data, "occupation"),
    employer: text(data, "employer"),
    annual_income: number(data, "annual_income"),
    phone: text(data, "phone"),
    email: text(data, "email"),
    address_area: text(data, "address_area"),
    status: text(data, "status") ?? "active",
    client_since: text(data, "client_since"),
    review_interval_days: number(data, "review_interval_days") ?? 180,
    profile_notes: text(data, "profile_notes"),
  };

  const id = text(data, "client_id");

  if (id) {
    const { error } = await db().from("clients").update(fields).eq("id", id);
    if (error) return { ok: false, error: error.message };
    revalidatePath(`/clients/${id}`);
    revalidatePath("/clients");
    return { ok: true, message: "Saved." };
  }

  const { data: created, error } = await db()
    .from("clients").insert(fields).select("id").single();
  if (error) return { ok: false, error: error.message };

  revalidatePath("/clients");
  redirect(`/clients/${created.id}`);
}

export async function deleteClient(data: FormData): Promise<void> {
  await requireUser();
  const id = text(data, "client_id");
  if (!id) return;

  // Policies, notes and family cascade with the client -- see the schema.
  await db().from("clients").delete().eq("id", id);
  revalidatePath("/clients");
  redirect("/clients");
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

export async function savePolicy(
  _prev: ActionResult | null,
  data: FormData,
): Promise<ActionResult> {
  await requireUser();

  if (formHasNric(data)) return { ok: false, error: NRIC_WARNING };

  const clientId = text(data, "client_id");
  const insurer = text(data, "insurer");
  const planName = text(data, "plan_name");

  if (!clientId) return { ok: false, error: "Missing client." };
  if (!insurer) return { ok: false, error: "An insurer is required." };
  if (!planName) return { ok: false, error: "A plan name is required." };

  const fields = {
    client_id: clientId,
    insurer,
    plan_name: planName,
    policy_number: text(data, "policy_number"),
    policy_type: text(data, "policy_type"),
    coverage_type: text(data, "coverage_type"),
    coverage_descriptor: text(data, "coverage_descriptor"),
    status: text(data, "status") ?? "in_force",
    sum_assured: number(data, "sum_assured"),
    annual_claim_limit: number(data, "annual_claim_limit"),

    // Two streams, not one. A Shield plan is often part CPF and part cash, and
    // the database derives premium_amount and paid_from_cpf from these.
    premium_cash: number(data, "premium_cash"),
    premium_non_cash: number(data, "premium_non_cash"),
    non_cash_source: text(data, "non_cash_source"),
    payment_method: text(data, "payment_method"),

    premium_mode: text(data, "premium_mode"),
    inception_date: text(data, "inception_date"),
    maturity_date: text(data, "maturity_date"),
    coverage_expiry_date: text(data, "coverage_expiry_date"),
    next_premium_due: text(data, "next_premium_due"),
    payment_term_years: number(data, "payment_term_years"),
    payment_until_age: number(data, "payment_until_age"),
    total_premium_paid: number(data, "total_premium_paid"),
    surrender_value: number(data, "surrender_value"),
    net_asset_value: number(data, "net_asset_value"),

    is_rider: bool(data, "is_rider"),
    cpf_account: text(data, "cpf_account"),
    is_integrated_shield: bool(data, "is_integrated_shield"),
    last_reviewed_at: text(data, "last_reviewed_at"),
    notes: text(data, "notes"),
  };

  const id = text(data, "policy_id");

  if (id) {
    const { error } = await db().from("policies").update(fields).eq("id", id);
    if (error) return { ok: false, error: friendlyPolicyError(error.message) };
  } else {
    const { error } = await db().from("policies").insert(fields);
    if (error) return { ok: false, error: friendlyPolicyError(error.message) };
  }

  revalidatePath(`/clients/${clientId}`);
  return { ok: true, message: "Saved." };
}

/** The unique constraint on (insurer, policy_number) is the one people hit. */
function friendlyPolicyError(message: string): string {
  if (message.includes("policies_real_number_idx")) {
    return "That policy number is already used by another policy with this insurer.";
  }
  if (message.includes("policies_identity_idx")) {
    return "This client already has a policy with that insurer, plan name and start date.";
  }
  return message;
}

export async function deletePolicy(data: FormData): Promise<void> {
  await requireUser();
  const id = text(data, "policy_id");
  const clientId = text(data, "client_id");
  if (!id) return;

  await db().from("policies").delete().eq("id", id);
  if (clientId) revalidatePath(`/clients/${clientId}`);
}

// ---------------------------------------------------------------------------
// Family
// ---------------------------------------------------------------------------

export async function saveFamilyMember(
  _prev: ActionResult | null,
  data: FormData,
): Promise<ActionResult> {
  await requireUser();

  if (formHasNric(data)) return { ok: false, error: NRIC_WARNING };

  const clientId = text(data, "client_id");
  const relationship = text(data, "relationship");
  if (!clientId || !relationship) {
    return { ok: false, error: "A relationship is required." };
  }

  const { error } = await db().from("family_members").insert({
    client_id: clientId,
    name: text(data, "name"),
    relationship,
    dob: text(data, "dob"),
    is_dependent: bool(data, "is_dependent"),
    is_insured: bool(data, "is_insured"),
    notes: text(data, "notes"),
  });

  if (error) return { ok: false, error: error.message };
  revalidatePath(`/clients/${clientId}`);
  return { ok: true, message: "Added." };
}

export async function deleteFamilyMember(data: FormData): Promise<void> {
  await requireUser();
  const id = text(data, "family_member_id");
  const clientId = text(data, "client_id");
  if (!id) return;

  await db().from("family_members").delete().eq("id", id);
  if (clientId) revalidatePath(`/clients/${clientId}`);
}

// ---------------------------------------------------------------------------
// Interactions and follow-ups
// ---------------------------------------------------------------------------

export async function logInteraction(
  _prev: ActionResult | null,
  data: FormData,
): Promise<ActionResult> {
  await requireUser();

  if (formHasNric(data)) return { ok: false, error: NRIC_WARNING };

  const clientId = text(data, "client_id");
  const summary = text(data, "summary");
  if (!clientId) return { ok: false, error: "Missing client." };
  if (!summary) return { ok: false, error: "Write a line about what was discussed." };

  const occurred = text(data, "occurred_on");

  const { error } = await db().from("interactions").insert({
    client_id: clientId,
    summary,
    detail: text(data, "detail"),
    channel: text(data, "channel") ?? "meeting",
    sentiment: text(data, "sentiment"),
    // A date-only input means midnight Singapore, not midnight UTC.
    occurred_at: occurred ? `${occurred}T12:00:00+08:00` : new Date().toISOString(),
    ai_generated: false,   // typed by the adviser, not written by the manager
  });

  if (error) return { ok: false, error: error.message };

  // The insert trigger also moves clients.last_contacted_at, which the
  // dashboard reads -- so refresh that too.
  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/");
  return { ok: true, message: "Filed." };
}

export async function createAction(
  _prev: ActionResult | null,
  data: FormData,
): Promise<ActionResult> {
  await requireUser();

  if (formHasNric(data)) return { ok: false, error: NRIC_WARNING };

  const title = text(data, "title");
  if (!title) return { ok: false, error: "What needs doing?" };

  const clientId = text(data, "client_id");

  const { error } = await db().from("action_items").insert({
    client_id: clientId,
    title,
    detail: text(data, "detail"),
    due_date: text(data, "due_date"),
    priority: text(data, "priority") ?? "normal",
  });

  if (error) return { ok: false, error: error.message };
  if (clientId) revalidatePath(`/clients/${clientId}`);
  revalidatePath("/");
  return { ok: true, message: "Added." };
}

export async function completeAction(data: FormData): Promise<void> {
  await requireUser();
  const id = text(data, "action_id");
  const clientId = text(data, "client_id");
  if (!id) return;

  await db().from("action_items").update({
    status: "done",
    completed_at: new Date().toISOString(),
  }).eq("id", id);

  if (clientId) revalidatePath(`/clients/${clientId}`);
  revalidatePath("/");
}
