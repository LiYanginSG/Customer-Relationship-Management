/**
 * Library -- the product documents, grouped by insurer.
 *
 * "Folders" here are insurers, because that is how the question actually
 * arrives: you want the AIA contract, not the third PDF you uploaded on a
 * Tuesday. Within each insurer, contracts come before summaries because that
 * is where the awkward questions get answered.
 */

import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Shell } from "@/components/Shell";
import { DocumentRow, type ProductDoc } from "@/components/DocumentRow";

export const dynamic = "force-dynamic";

// Contracts first: they hold the exclusions and definitions.
const TYPE_ORDER = [
  "policy_contract", "product_summary", "brochure", "rate_table",
  "underwriting_guide", "benefit_illustration", "fund_factsheet",
  "circular", "other",
];

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const query = (params.q ?? "").trim();

  // Passage search, when they are looking for wording rather than a document.
  const passages = query
    ? (await db().rpc("search_products", {
        query_text: query,
        insurer_filter: null,
        max_results: 8,
      })).data as Array<Record<string, unknown>> | null
    : null;

  const { data, error } = await db()
    .from("products")
    .select("id, insurer, name, doc_type, status, page_count, effective_date, " +
            "storage_path, source_filename, ingested_at, ingest_error, product_chunks(count)")
    .order("insurer")
    .order("name");

  // The embedded product_chunks(count) relation confuses the generated types,
  // so go through unknown rather than fight it.
  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;

  const docs: ProductDoc[] = rows.map((row) => {
    const chunks = row.product_chunks as Array<{ count: number }> | undefined;
    return {
      id: String(row.id),
      insurer: String(row.insurer),
      name: String(row.name),
      doc_type: row.doc_type as string | null,
      status: String(row.status),
      page_count: row.page_count as number | null,
      effective_date: row.effective_date as string | null,
      storage_path: row.storage_path as string | null,
      source_filename: row.source_filename as string | null,
      ingested_at: row.ingested_at as string | null,
      ingest_error: row.ingest_error as string | null,
      chunk_count: chunks?.[0]?.count ?? 0,
    };
  });

  const byInsurer = new Map<string, ProductDoc[]>();
  for (const doc of docs) {
    byInsurer.set(doc.insurer, [...(byInsurer.get(doc.insurer) ?? []), doc]);
  }
  for (const list of byInsurer.values()) {
    list.sort((a, b) => {
      const order = TYPE_ORDER.indexOf(a.doc_type ?? "other") -
                    TYPE_ORDER.indexOf(b.doc_type ?? "other");
      return order !== 0 ? order : a.name.localeCompare(b.name);
    });
  }

  const totalSections = docs.reduce((sum, d) => sum + d.chunk_count, 0);
  const unreadable = docs.filter((d) => d.chunk_count === 0);

  return (
    <Shell email={user.email}>
      <div className="flex flex-wrap items-baseline justify-between gap-3 mb-5">
        <h1 className="text-lg font-semibold tracking-tight">
          Library
          {docs.length > 0 && (
            <span className="ml-2 text-sm font-normal text-ink-faint">
              {docs.length} document{docs.length === 1 ? "" : "s"} ·{" "}
              {totalSections.toLocaleString()} searchable sections
            </span>
          )}
        </h1>
      </div>

      <form className="card p-3 mb-5 flex flex-wrap gap-2 items-center">
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="Search the wording — deferment period, pre-existing exclusion…"
          className="input flex-1 min-w-[220px]"
        />
        <button type="submit" className="btn-quiet">Search</button>
        {query && (
          <Link href="/library" className="text-sm text-ink-soft hover:text-ink px-2">
            Clear
          </Link>
        )}
      </form>

      {/* Passage results, when searching. */}
      {passages && (
        <section className="mb-6">
          <h2 className="text-sm font-semibold mb-3">
            {passages.length === 0
              ? `Nothing matches "${query}"`
              : `${passages.length} passage${passages.length === 1 ? "" : "s"} matching "${query}"`}
          </h2>
          <div className="space-y-3">
            {passages.map((p, i) => (
              <div key={i} className="card p-4">
                <div className="flex items-baseline justify-between gap-3 mb-1.5">
                  <span className="text-sm font-medium">
                    {String(p.heading ?? "Extract")}
                  </span>
                  <span className="text-xs text-ink-faint shrink-0">
                    {String(p.insurer)} · {String(p.product_name)}
                    {p.page_from ? ` · p${p.page_from}` : ""}
                  </span>
                </div>
                {p.match_type === "partial" && (
                  <span className="chip bg-warn/10 text-warn mb-2 inline-block">
                    Loose match — read carefully
                  </span>
                )}
                <p className="text-sm text-ink-soft whitespace-pre-wrap">
                  {String(p.content).slice(0, 900)}
                  {String(p.content).length > 900 ? "…" : ""}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      {error && <div className="card p-4 text-sm text-alert">{error.message}</div>}

      {!error && docs.length === 0 && (
        <div className="card p-8 text-center">
          <p className="text-sm font-medium">Nothing uploaded yet.</p>
          <p className="mt-1.5 text-sm text-ink-soft max-w-md mx-auto">
            Send a product PDF to your Telegram bot with a caption naming it, like{" "}
            <code className="text-xs">AIA Max VitalHealth A</code>. It will be indexed
            and appear here.
          </p>
        </div>
      )}

      {unreadable.length > 0 && (
        <div className="card p-4 mb-5 border-warn/30 bg-warn/5">
          <p className="text-sm font-medium text-warn">
            {unreadable.length} document{unreadable.length === 1 ? " has" : "s have"} no
            searchable text
          </p>
          <p className="mt-1 text-sm text-ink-soft">
            Almost always a scanned PDF — pictures of pages rather than text. The file is
            stored but cannot be searched. Download the text version from the insurer&apos;s
            site and re-upload.
          </p>
        </div>
      )}

      <div className="space-y-5">
        {[...byInsurer.entries()].map(([insurer, list]) => (
          <section key={insurer} className="card overflow-hidden">
            <h2 className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wide
                           text-ink-soft bg-surface-sunk border-b border-line
                           flex items-center justify-between">
              <span>{insurer}</span>
              <span className="font-normal normal-case text-ink-faint">
                {list.length} document{list.length === 1 ? "" : "s"}
              </span>
            </h2>
            <ul className="divide-y divide-line">
              {list.map((doc) => <DocumentRow key={doc.id} doc={doc} />)}
            </ul>
          </section>
        ))}
      </div>
    </Shell>
  );
}
