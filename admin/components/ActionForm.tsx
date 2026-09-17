"use client";

import { useActionState, useRef } from "react";
import { createAction, type ActionResult } from "@/lib/actions";
import { Field, Select, FormMessage } from "./Field";
import { SubmitButton } from "./SubmitButton";

export function ActionForm({ clientId }: { clientId: string }) {
  const formRef = useRef<HTMLFormElement>(null);

  const [result, action] = useActionState<ActionResult | null, FormData>(
    async (prev, data) => {
      const outcome = await createAction(prev, data);
      if (outcome.ok) formRef.current?.reset();
      return outcome;
    },
    null,
  );

  return (
    <form ref={formRef} action={action} className="space-y-4">
      <input type="hidden" name="client_id" value={clientId} />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Field label="What you promised" name="title" required
               placeholder="Send Shield plan comparison" className="sm:col-span-2" />
        <Field label="By when" name="due_date" type="date" />
      </div>

      <Select label="Priority" name="priority" defaultValue="normal"
              options={[
                { value: "low", label: "Low" },
                { value: "normal", label: "Normal" },
                { value: "high", label: "High" },
                { value: "urgent", label: "Urgent" },
              ]} />

      <div className="flex items-center gap-3">
        <SubmitButton>Add follow-up</SubmitButton>
        <FormMessage result={result} />
      </div>
    </form>
  );
}
