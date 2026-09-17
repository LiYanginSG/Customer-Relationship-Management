"use client";

import { useActionState, useState } from "react";
import { savePolicy, type ActionResult } from "@/lib/actions";
import { Field, Select, TextArea, Checkbox, FormMessage } from "./Field";
import { SubmitButton } from "./SubmitButton";
import { POLICY_TYPES, POLICY_STATUSES, PREMIUM_MODES } from "@/lib/format";

export interface PolicyRecord {
  id?: string;
  insurer?: string | null;
  plan_name?: string | null;
  policy_number?: string | null;
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

  const [cpf, setCpf] = useState(Boolean(policy?.paid_from_cpf));

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="client_id" value={clientId} />
      {policy?.id && <input type="hidden" name="policy_id" value={policy.id} />}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Insurer" name="insurer" required defaultValue={policy?.insurer}
               placeholder="AIA" />
        <Field label="Plan name" name="plan_name" required defaultValue={policy?.plan_name}
               placeholder="Pro Achiever" />
        <Field label="Policy number" name="policy_number" defaultValue={policy?.policy_number} />
        <Select label="Type" name="policy_type" defaultValue={policy?.policy_type}
                includeBlank="Not set" options={POLICY_TYPES} />
        <Select label="Status" name="status" defaultValue={policy?.status ?? "in_force"}
                options={POLICY_STATUSES} />
        <Field label="Sum assured" name="sum_assured" defaultValue={policy?.sum_assured}
               placeholder="250000" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Field label="Premium" name="premium_amount" defaultValue={policy?.premium_amount}
               placeholder="450" />
        <Select label="Paid" name="premium_mode" defaultValue={policy?.premium_mode}
                includeBlank="Not set" options={PREMIUM_MODES} />
        <Field label="Next due" name="next_premium_due" type="date"
               defaultValue={policy?.next_premium_due}
               hint="Drives the premium reminders." />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Field label="Inception" name="inception_date" type="date"
               defaultValue={policy?.inception_date} hint="Sets the anniversary." />
        <Field label="Maturity" name="maturity_date" type="date"
               defaultValue={policy?.maturity_date} />
        <Field label="Last reviewed" name="last_reviewed_at" type="date"
               defaultValue={policy?.last_reviewed_at} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-start">
        <Checkbox label="Paid from CPF" name="paid_from_cpf" defaultChecked={cpf}
                  onChange={setCpf}
                  hint="These lapse quietly if the account runs dry." />
        {cpf && (
          <Select label="CPF account" name="cpf_account" defaultValue={policy?.cpf_account}
                  includeBlank="Not set"
                  options={[
                    { value: "oa", label: "Ordinary Account" },
                    { value: "sa", label: "Special Account" },
                    { value: "medisave", label: "MediSave" },
                    { value: "ma_shield", label: "MediSave (Shield)" },
                  ]} />
        )}
        <Checkbox label="Integrated Shield" name="is_integrated_shield"
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
