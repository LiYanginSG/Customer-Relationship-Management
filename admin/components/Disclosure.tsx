"use client";

import { useState } from "react";

/** A section that stays out of the way until you need it. */
export function Disclosure({
  label, children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="btn-quiet">
        {label}
      </button>
    );
  }

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold">{label}</h3>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-sm text-ink-soft hover:text-ink"
        >
          Cancel
        </button>
      </div>
      {children}
    </div>
  );
}
