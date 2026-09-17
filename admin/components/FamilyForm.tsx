"use client";

import { useActionState, useRef } from "react";
import { saveFamilyMember, type ActionResult } from "@/lib/actions";
import { Field, Select, Checkbox, FormMessage } from "./Field";
import { SubmitButton } from "./SubmitButton";
import { RELATIONSHIPS } from "@/lib/format";

export function FamilyForm({ clientId }: { clientId: string }) {
  const formRef = useRef<HTMLFormElement>(null);

  const [result, action] = useActionState<ActionResult | null, FormData>(
    async (prev, data) => {
      const outcome = await saveFamilyMember(prev, data);
      if (outcome.ok) formRef.current?.reset();
      return outcome;
    },
    null,
  );

  return (
    <form ref={formRef} action={action} className="space-y-4">
      <input type="hidden" name="client_id" value={clientId} />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Field label="Name" name="name" placeholder="Anya" />
        <Select label="Relationship" name="relationship" options={RELATIONSHIPS} />
        <Field label="Date of birth" name="dob" type="date"
               hint="A child's birthday is often the better reason to call." />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Checkbox label="Financially dependent" name="is_dependent" />
        <Checkbox label="Already covered" name="is_insured"
                  hint="Leave unticked and they show up as a protection gap." />
      </div>

      <div className="flex items-center gap-3">
        <SubmitButton>Add</SubmitButton>
        <FormMessage result={result} />
      </div>
    </form>
  );
}
