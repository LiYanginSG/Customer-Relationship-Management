"use client";

import { useFormStatus } from "react-dom";

/**
 * Disables itself while the action runs. Without this, an impatient double
 * click on "Add policy" files the policy twice.
 */
export function SubmitButton({
  children = "Save",
  variant = "primary",
}: {
  children?: React.ReactNode;
  variant?: "primary" | "quiet";
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={variant === "primary" ? "btn-primary" : "btn-quiet"}
    >
      {pending ? "Saving…" : children}
    </button>
  );
}
