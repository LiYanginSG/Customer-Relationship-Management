"use client";

import { useActionState, useState } from "react";
import {
  deleteProduct, setProductStatus, updateProduct, signedDocumentUrl,
  type ActionResult,
} from "@/lib/actions";
import { Field, Select, FormMessage } from "./Field";
import { SubmitButton } from "./SubmitButton";
import { formatDate } from "@/lib/format";

export const DOC_TYPES = [
  { value: "policy_contract", label: "Policy contract" },
  { value: "product_summary", label: "Product summary" },
  { value: "brochure", label: "Brochure" },
  { value: "benefit_illustration", label: "Benefit illustration" },
  { value: "fund_factsheet", label: "Fund factsheet" },
  { value: "underwriting_guide", label: "Underwriting guide" },
  { value: "rate_table", label: "Rate table" },
  { value: "circular", label: "Circular" },
  { value: "other", label: "Other" },
];

export interface ProductDoc {
  id: string;
  insurer: string;
  name: string;
  doc_type: string | null;
  status: string;
  page_count: number | null;
  effective_date: string | null;
  storage_path: string | null;
  source_filename: string | null;
  ingested_at: string | null;
  ingest_error: string | null;
  chunk_count: number;
}

export function DocumentRow({ doc }: { doc: ProductDoc }) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [opening, setOpening] = useState(false);

  const [result, editAction] = useActionState<ActionResult | null, FormData>(
    async (prev, data) => {
      const outcome = await updateProduct(prev, data);
      if (outcome.ok) setEditing(false);
      return outcome;
    },
    null,
  );

  async function openPdf() {
    if (!doc.storage_path) return;
    setOpening(true);
    const url = await signedDocumentUrl(doc.storage_path);
    setOpening(false);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }

  const typeLabel =
    DOC_TYPES.find((t) => t.value === doc.doc_type)?.label ?? doc.doc_type ?? "Document";

  if (editing) {
    return (
      <li className="p-4 bg-surface-sunk">
        <form action={editAction} className="space-y-4">
          <input type="hidden" name="product_id" value={doc.id} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Insurer" name="insurer" required defaultValue={doc.insurer}
                   hint="Guessed from your caption. Fix it here." />
            <Field label="Document name" name="name" required defaultValue={doc.name} />
            <Select label="Type" name="doc_type" defaultValue={doc.doc_type}
                    options={DOC_TYPES} />
            <Field label="Effective date" name="effective_date" type="date"
                   defaultValue={doc.effective_date} />
          </div>
          <div className="flex items-center gap-3">
            <SubmitButton>Save</SubmitButton>
            <button type="button" onClick={() => setEditing(false)}
                    className="text-sm text-ink-soft hover:text-ink">
              Cancel
            </button>
            <FormMessage result={result} />
          </div>
        </form>
      </li>
    );
  }

  return (
    <li className={`p-4 ${doc.status !== "current" ? "opacity-60" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">{doc.name}</h3>
          <p className="text-xs text-ink-soft mt-0.5">
            {[
              typeLabel,
              doc.page_count ? `${doc.page_count} pages` : null,
              `${doc.chunk_count} searchable sections`,
              doc.effective_date ? `effective ${formatDate(doc.effective_date)}` : null,
            ].filter(Boolean).join(" · ")}
          </p>

          {doc.status !== "current" && (
            <span className="chip bg-warn/10 text-warn mt-2 inline-block">
              {doc.status === "superseded" ? "Superseded" : "Withdrawn"} — excluded from search
            </span>
          )}
          {doc.chunk_count === 0 && (
            <p className="text-xs text-alert mt-1.5">
              Nothing indexed. {doc.ingest_error ?? "Likely a scanned PDF, which has no text to read."}
            </p>
          )}
        </div>

        <div className="flex items-center gap-3 shrink-0 text-xs">
          {doc.storage_path && (
            <button type="button" onClick={openPdf} disabled={opening}
                    className="text-ink-soft hover:text-ink disabled:opacity-50">
              {opening ? "Opening…" : "Open PDF"}
            </button>
          )}
          <button type="button" onClick={() => setEditing(true)}
                  className="text-ink-soft hover:text-ink">
            Edit
          </button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
        {doc.status === "current" ? (
          <form action={setProductStatus}>
            <input type="hidden" name="product_id" value={doc.id} />
            <input type="hidden" name="status" value="superseded" />
            <button type="submit" className="text-ink-faint hover:text-warn">
              Mark superseded
            </button>
          </form>
        ) : (
          <form action={setProductStatus}>
            <input type="hidden" name="product_id" value={doc.id} />
            <input type="hidden" name="status" value="current" />
            <button type="submit" className="text-ink-faint hover:text-good">
              Make current again
            </button>
          </form>
        )}

        {/* Two-step delete. This removes the file as well as the record, and
            there is no undo, so a single misclick should not do it. */}
        {confirming ? (
          <form action={deleteProduct} className="flex items-center gap-2">
            <input type="hidden" name="product_id" value={doc.id} />
            <span className="text-alert">Delete permanently?</span>
            <button type="submit" className="font-medium text-alert hover:underline">
              Yes, delete
            </button>
            <button type="button" onClick={() => setConfirming(false)}
                    className="text-ink-soft hover:text-ink">
              Cancel
            </button>
          </form>
        ) : (
          <button type="button" onClick={() => setConfirming(true)}
                  className="text-ink-faint hover:text-alert">
            Delete
          </button>
        )}
      </div>
    </li>
  );
}
