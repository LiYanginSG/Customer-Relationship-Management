"use client";

import { useActionState } from "react";
import { savePolicy, type ActionResult } from "@/lib/actions";
import { Field, Select, TextArea, Checkbox, FormMessage } from "./Field";
import { SubmitButton } from "./SubmitButton";
import {
  POLICY_TYPES, POLICY_STATUSES, PREMIUM_MODES, COVERAGE_TYPES,
  NON_CASH_SOURCES, PAYMENT_METHODS, isMaskedPolicyNumber,
} from "@/lib/format";

export interface PolicyRecord {
  id?: string;
  insurer?: string | null;
  plan_name?: string | null;
  policy_number?: string | null;
  policy_number_masked?: string | null;
  coverage_type?: string | null;
  coverage_descriptor?: string | null;
  annual_claim_limit?: number | null;
  premium_cash?: number | null;
  premium_non_cash?: number | null;
  non_cash_source?: string | null;
  payment_method?: string | null;
  coverage_expiry_date?: string | null;
  payment_term_years?: number | null;
  payment_until_age?: number | null;
  total_premium_paid?: number | null;
  surrender_value?: number | null;
  net_asset_value?: number | null;
  is_rider?: boolean | null;
  policy_type?: string | null;
  status?: string | null;
  sum_assured?: number | null;
  premium_amount?: number | null;
  premium_mode?: string | null;
  inception_date?: string | null;
  maturity_date?: string | null;
  next_premium_due?: string | null;
  paid_from_cpf?: boolean | null;
  cpf_account?: string | null;
  is_integrated_shield?: boolean | null;
  last_reviewed_at?: string | null;
  notes?: string | null;
}

export function PolicyForm({
  clientId, policy, onDone,
}: {
  clientId: string;
  policy?: PolicyRecord;
  onDone?: () => void;
}) {
  const [result, action] = useActionState<ActionResult | null, FormData>(
    async (prev, data) => {
      const outcome = await savePolicy(prev, data);
      if (outcome.ok) onDone?.();
      return outcome;
    },
    null,
  );

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="client_id" value={clientId} />
      {policy?.id && <input type="hidden" name="policy_id" value={policy.id} />}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Insurer" name="insurer" required defaultValue={policy?.insurer}
               placeholder="AIA" />
        <Field label="Plan name" name="plan_name" required defaultValue={policy?.plan_name}
               placeholder="AIA HSG MAX B" />
        <Field
          label="Policy number"
          name="policy_number"
          defaultValue={policy?.policy_number}
          placeholder={policy?.policy_number_masked ?? ""}
          hint={
            policy?.policy_number_masked && !policy?.policy_number
              ? `Your export only gave ${policy.policy_number_masked}. Type the full number here \u2014 it is then checked for duplicates.`
              : "Must be unique for this insurer."
          }
        />
        <Select label="Category" name="policy_type" defaultValue={policy?.policy_type}
                includeBlank="Not set" options={POLICY_TYPES} />
        <Select label="Covers" name="coverage_type" defaultValue={policy?.coverage_type}
                includeBlank="Not set" options={COVERAGE_TYPES}
                hint="As the insurer's summary prints it." />
        <Select label="Status" name="status" defaultValue={policy?.status ?? "in_force"}
                options={POLICY_STATUSES} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Field label="Sum assured" name="sum_assured" defaultValue={policy?.sum_assured}
               placeholder="120000" hint="Leave blank where cover is a class, not a sum." />
        <Field label="Cover described as" name="coverage_descriptor"
               defaultValue={policy?.coverage_descriptor}
               placeholder="Restructured (A ward)"
               hint="For hospitalisation plans." />
        <Field label="Annual claim limit" name="annual_claim_limit"
               defaultValue={policy?.annual_claim_limit} placeholder="1200000" />
      </div>

      <div className="rounded-md border border-line bg-surface-sunk p-4">
        <h4 className="text-xs font-semibold text-ink-soft mb-3">Premium</h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Paid by cash" name="premium_cash" defaultValue={policy?.premium_cash}
                 placeholder="255.00" />
          <Select label="Cash method" name="payment_method" defaultValue={policy?.payment_method}
                  includeBlank="Not set" options={PAYMENT_METHODS} />
          <Field label="Paid by CPF / SRS" name="premium_non_cash"
                 defaultValue={policy?.premium_non_cash} placeholder="408.48" />
          <Select label="Which account" name="non_cash_source"
                  defaultValue={policy?.non_cash_source} includeBlank="Not set"
                  options={NON_CASH_SOURCES} />
        </div>
        <p className="mt-3 text-xs text-ink-faint">
          A plan can be part cash and part CPF. The total and the CPF flag are worked
          out from these two. Shield <em>riders</em> are always cash \u2014 MediSave
          cannot be used for them at any age.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
          <Select label="How often" name="premium_mode" defaultValue={policy?.premium_mode}
                  includeBlank="Not set" options={PREMIUM_MODES} />
          <Field label="Next due" name="next_premium_due" type="date"
                 defaultValue={policy?.next_premium_due}
                 hint="Drives the premium reminders." />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Field label="Inception" name="inception_date" type="date"
               defaultValue={policy?.inception_date} hint="Sets the anniversary." />
        <Field label="Coverage expiry" name="coverage_expiry_date" type="date"
               defaultValue={policy?.coverage_expiry_date}
               hint="Riders often expire before their parent plan." />
        <Field label="Maturity" name="maturity_date" type="date"
               defaultValue={policy?.maturity_date} />
        <Field label="Pay for (years)" name="payment_term_years"
               defaultValue={policy?.payment_term_years} placeholder="75" />
        <Field label="Until age" name="payment_until_age"
               defaultValue={policy?.payment_until_age} placeholder="100" />
        <Field label="Last reviewed" name="last_reviewed_at" type="date"
               defaultValue={policy?.last_reviewed_at} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Field label="Premium paid to date" name="total_premium_paid"
               defaultValue={policy?.total_premium_paid} />
        <Field label="Surrender value" name="surrender_value"
               defaultValue={policy?.surrender_value} />
        <Field label="Net asset value" name="net_asset_value"
               defaultValue={policy?.net_asset_value} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-start">
        <Checkbox label="This is a rider" name="is_rider"
                  defaultChecked={Boolean(policy?.is_rider)}
                  hint="Attached to a main plan. Shield riders are never CPF-payable." />
        <Checkbox label="Integrated Shield plan" name="is_integrated_shield"
                  defaultChecked={Boolean(policy?.is_integrated_shield)} />
      </div>

      <TextArea label="Notes" name="notes" defaultValue={policy?.notes} rows={2} />

      <div className="flex items-center gap-3">
        <SubmitButton>{policy?.id ? "Save policy" : "Add policy"}</SubmitButton>
        <FormMessage result={result} />
      </div>
    </form>
  );
}
