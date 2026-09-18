"use client";

import { useState } from "react";
import { PolicyForm, type PolicyRecord } from "./PolicyForm";
import { deletePolicy } from "@/lib/actions";
import {
  formatDate, labelFor, money, sgToday,
  POLICY_TYPES, POLICY_STATUSES, PREMIUM_MODES,
} from "@/lib/format";

interface Policy extends PolicyRecord {
  id: string;
}

export function PolicyCard({ policy, clientId }: { policy: Policy; clientId: string }) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <div className="card p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold">
            {policy.insurer} {policy.plan_name}
          </h3>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="text-sm text-ink-soft hover:text-ink"
          >
            Cancel
          </button>
        </div>

        <PolicyForm
          clientId={clientId}
          policy={policy}
          onDone={() => setEditing(false)}
        />

        <form
          action={deletePolicy}
          className="mt-5 pt-4 border-t border-line"
          onSubmit={(e) => {
            if (!confirm(`Delete ${policy.insurer} ${policy.plan_name}? This cannot be undone.`)) {
              e.preventDefault();
            }
          }}
        >
          <input type="hidden" name="policy_id" value={policy.id} />
          <input type="hidden" name="client_id" value={clientId} />
          <button type="submit" className="text-xs text-ink-faint hover:text-alert">
            Delete this policy
          </button>
        </form>
      </div>
    );
  }

  const today = sgToday();
  const overdue =
    policy.status === "in_force" &&
    policy.next_premium_due != null &&
    policy.next_premium_due < today;

  const lapsed = policy.status !== "in_force";

  return (
    <div className={`card p-4 ${lapsed ? "opacity-60" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">
            {policy.insurer} {policy.plan_name}
          </h3>
          <p className="text-xs text-ink-soft mt-0.5">
            {[
              policy.coverage_type ?? labelFor(POLICY_TYPES, policy.policy_type),
              policy.policy_number,
              lapsed ? labelFor(POLICY_STATUSES, policy.status) : null,
            ].filter(Boolean).join(" · ")}
          </p>
          {!policy.policy_number && policy.policy_number_masked && (
            <p className="text-xs text-warn mt-0.5">
              Number only known as {policy.policy_number_masked} — add the full one
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-xs text-ink-soft hover:text-ink shrink-0"
        >
          Edit
        </button>
      </div>

      <dl className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 text-xs">
        <div>
          <dt className="text-ink-faint">Cover</dt>
          <dd className="tabular-nums mt-0.5">
            {policy.coverage_descriptor ?? money(policy.sum_assured)}
          </dd>
        </div>
        <div>
          <dt className="text-ink-faint">Premium</dt>
          <dd className="tabular-nums mt-0.5">
            {money(policy.premium_amount)}
            {policy.premium_mode && (
              <span className="text-ink-faint">
                {" "}/ {labelFor(PREMIUM_MODES, policy.premium_mode).toLowerCase()}
              </span>
            )}
            {/* Where a plan is split, showing only the total hides the thing
                that actually matters when a MediSave balance runs low. */}
            {policy.premium_cash != null && policy.premium_non_cash != null && (
              <span className="block text-ink-faint">
                {money(policy.premium_cash)} cash + {money(policy.premium_non_cash)}{" "}
                {policy.non_cash_source ?? "CPF"}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-ink-faint">Started</dt>
          <dd className="mt-0.5">{formatDate(policy.inception_date)}</dd>
        </div>
        <div>
          <dt className="text-ink-faint">
            {policy.next_premium_due ? "Next due" : "Expires"}
          </dt>
          <dd className={`mt-0.5 ${overdue ? "text-alert font-medium" : ""}`}>
            {policy.next_premium_due
              ? formatDate(policy.next_premium_due)
              : formatDate(policy.coverage_expiry_date)}
          </dd>
        </div>
      </dl>

      {(overdue || policy.is_rider || (policy.premium_non_cash ?? 0) > 0 ||
        !policy.last_reviewed_at) && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {overdue && (
            <span className="chip bg-alert/10 text-alert">Premium overdue</span>
          )}
          {policy.is_rider && (
            <span className="chip bg-surface-sunk text-ink-soft">Rider</span>
          )}
          {policy.premium_non_cash != null && policy.premium_non_cash > 0 && (
            <span className="chip bg-surface-sunk text-ink-soft">
              {policy.non_cash_source ?? "CPF"}-funded
            </span>
          )}
          {!policy.last_reviewed_at && policy.status === "in_force" && (
            <span className="chip bg-warn/10 text-warn">Never reviewed</span>
          )}
        </div>
      )}

      {policy.notes && (
        <p className="mt-3 text-xs text-ink-soft whitespace-pre-wrap">{policy.notes}</p>
      )}
    </div>
  );
}
