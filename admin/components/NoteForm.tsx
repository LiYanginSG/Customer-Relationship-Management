"use client";

import { useActionState, useRef } from "react";
import { logInteraction, type ActionResult } from "@/lib/actions";
import { Select, TextArea, FormMessage } from "./Field";
import { SubmitButton } from "./SubmitButton";
import { CHANNELS } from "@/lib/format";

export function NoteForm({ clientId, today }: { clientId: string; today: string }) {
  const formRef = useRef<HTMLFormElement>(null);

  const [result, action] = useActionState<ActionResult | null, FormData>(
    async (prev, data) => {
      const outcome = await logInteraction(prev, data);
      // Clear the form on success so the next note starts blank rather than
      // with the last one still sitting in the box.
      if (outcome.ok) formRef.current?.reset();
      return outcome;
    },
    null,
  );

  return (
    <form ref={formRef} action={action} className="space-y-4">
      <input type="hidden" name="client_id" value={clientId} />

      <TextArea
        label="What was discussed"
        name="summary"
        required
        rows={2}
        placeholder="Reviewed term cover. Husband changing jobs in Q1, group cover will drop."
        hint="One or two lines. This is what you re-read before the next meeting."
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Select label="How" name="channel" defaultValue="meeting" options={CHANNELS} />
        <div>
          <label htmlFor="occurred_on" className="label">When</label>
          <input id="occurred_on" name="occurred_on" type="date"
                 defaultValue={today} max={today} className="input" />
        </div>
        <Select label="How it felt" name="sentiment" includeBlank="Not noted"
                options={[
                  { value: "positive", label: "Positive" },
                  { value: "neutral", label: "Neutral" },
                  { value: "concerned", label: "Concerned" },
                  { value: "negative", label: "Negative" },
                ]} />
      </div>

      <TextArea label="Fuller note" name="detail" rows={3}
                placeholder="Anything else worth remembering." />

      <div className="flex items-center gap-3">
        <SubmitButton>File note</SubmitButton>
        <FormMessage result={result} />
      </div>
    </form>
  );
}
