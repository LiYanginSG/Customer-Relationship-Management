"use client";

import { useActionState } from "react";
import { saveClient, type ActionResult } from "@/lib/actions";
import { Field, Select, TextArea, FormMessage } from "./Field";
import { SubmitButton } from "./SubmitButton";
import { CLIENT_STATUSES, RESIDENCY } from "@/lib/format";

interface ClientRecord {
  id?: string;
  full_name?: string | null;
  preferred_name?: string | null;
  dob?: string | null;
  gender?: string | null;
  marital_status?: string | null;
  residency?: string | null;
  occupation?: string | null;
  employer?: string | null;
  annual_income?: number | null;
  phone?: string | null;
  email?: string | null;
  address_area?: string | null;
  status?: string | null;
  client_since?: string | null;
  review_interval_days?: number | null;
  profile_notes?: string | null;
}

export function ClientForm({ client }: { client?: ClientRecord }) {
  const [result, action] = useActionState<ActionResult | null, FormData>(
    saveClient,
    null,
  );

  return (
    <form action={action} className="space-y-6">
      {client?.id && <input type="hidden" name="client_id" value={client.id} />}

      <div className="card p-5">
        <h2 className="text-sm font-semibold mb-4">Who they are</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Full name" name="full_name" required
                 defaultValue={client?.full_name} placeholder="Tan Wei Ming" />
          <Field label="Goes by" name="preferred_name"
                 defaultValue={client?.preferred_name} placeholder="Wei Ming" />
          <Field label="Date of birth" name="dob" type="date" defaultValue={client?.dob}
                 hint="Drives birthday alerts and age-based milestones." />
          <Select label="Gender" name="gender" defaultValue={client?.gender}
                  includeBlank="Not recorded"
                  options={[
                    { value: "M", label: "Male" },
                    { value: "F", label: "Female" },
                    { value: "other", label: "Other" },
                  ]} />
          <Select label="Marital status" name="marital_status"
                  defaultValue={client?.marital_status} includeBlank="Not recorded"
                  options={[
                    { value: "single", label: "Single" },
                    { value: "married", label: "Married" },
                    { value: "divorced", label: "Divorced" },
                    { value: "widowed", label: "Widowed" },
                  ]} />
          <Select label="Residency" name="residency" defaultValue={client?.residency ?? "unknown"}
                  options={RESIDENCY}
                  hint="Determines CPF eligibility, so worth getting right." />
        </div>
      </div>

      <div className="card p-5">
        <h2 className="text-sm font-semibold mb-4">Work and contact</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Occupation" name="occupation" defaultValue={client?.occupation} />
          <Field label="Employer" name="employer" defaultValue={client?.employer} />
          <Field label="Annual income" name="annual_income" defaultValue={client?.annual_income}
                 placeholder="120000" hint="Used to sense-check cover against income." />
          <Field label="Phone" name="phone" type="tel" defaultValue={client?.phone} />
          <Field label="Email" name="email" type="email" defaultValue={client?.email} />
          <Field label="Area" name="address_area" defaultValue={client?.address_area}
                 placeholder="Punggol" hint="Enough to plan a day of visits." />
        </div>
      </div>

      <div className="card p-5">
        <h2 className="text-sm font-semibold mb-4">Servicing</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Select label="Status" name="status" defaultValue={client?.status ?? "active"}
                  options={CLIENT_STATUSES} />
          <Field label="Client since" name="client_since" type="date"
                 defaultValue={client?.client_since} />
          <Field label="Contact every (days)" name="review_interval_days"
                 defaultValue={client?.review_interval_days ?? 180}
                 hint="They appear under 'gone quiet' past this." />
        </div>
        <TextArea label="Standing notes" name="profile_notes" rows={4} className="mt-4"
                  defaultValue={client?.profile_notes}
                  placeholder="Hates phone calls, text only. Two kids, Anya and Ryan. Wife works at DBS."
                  hint="Context that stays true. Meeting-by-meeting notes go in the timeline instead." />
      </div>

      <div className="flex items-center gap-3">
        <SubmitButton>{client?.id ? "Save changes" : "Add client"}</SubmitButton>
        <FormMessage result={result} />
      </div>

      <p className="text-xs text-ink-faint">
        Do not enter an NRIC or FIN anywhere. This system stores none by design, and
        one typed here will be stripped automatically.
      </p>
    </form>
  );
}
