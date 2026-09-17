import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Shell } from "@/components/Shell";
import { age, formatDate, labelFor, CLIENT_STATUSES } from "@/lib/format";

export const dynamic = "force-dynamic";

interface ClientRow {
  id: string;
  full_name: string;
  preferred_name: string | null;
  dob: string | null;
  status: string;
  phone: string | null;
  occupation: string | null;
  last_contacted_at: string | null;
  review_interval_days: number;
  policies: { count: number }[];
}

function daysSince(ts: string | null): number | null {
  if (!ts) return null;
  return Math.floor((Date.now() - new Date(ts).getTime()) / 86400000);
}

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const query = (params.q ?? "").trim();
  const status = params.status ?? "";

  let request = db()
    .from("clients")
    .select(
      "id, full_name, preferred_name, dob, status, phone, occupation, " +
        "last_contacted_at, review_interval_days, policies(count)",
    );

  if (query) request = request.ilike("full_name", `%${query}%`);
  if (status) request = request.eq("status", status);

  const { data, error } = await request.order("full_name").limit(500);
  const clients = (data ?? []) as unknown as ClientRow[];

  return (
    <Shell email={user.email}>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <h1 className="text-lg font-semibold tracking-tight">
          Clients
          {clients.length > 0 && (
            <span className="ml-2 text-sm font-normal text-ink-faint">
              {clients.length}
            </span>
          )}
        </h1>
        <Link href="/clients/new" className="btn-primary">Add client</Link>
      </div>

      <form className="card p-3 mb-5 flex flex-wrap gap-2 items-center">
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="Search by name…"
          className="input flex-1 min-w-[180px]"
        />
        <select name="status" defaultValue={status} className="input w-auto">
          <option value="">All statuses</option>
          {CLIENT_STATUSES.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <button type="submit" className="btn-quiet">Search</button>
        {(query || status) && (
          <Link href="/clients" className="text-sm text-ink-soft hover:text-ink px-2">
            Clear
          </Link>
        )}
      </form>

      {error && (
        <div className="card p-4 text-sm text-alert">{error.message}</div>
      )}

      {!error && clients.length === 0 && (
        <div className="card p-8 text-center">
          <p className="text-sm font-medium">
            {query || status ? "Nobody matches that." : "No clients yet."}
          </p>
          <p className="mt-1.5 text-sm text-ink-soft">
            {query || status
              ? "Try a different search."
              : "Add someone here, or send a spreadsheet to your Telegram bot to import in bulk."}
          </p>
          {!query && !status && (
            <Link href="/clients/new" className="btn-primary mt-5">Add your first client</Link>
          )}
        </div>
      )}

      {clients.length > 0 && (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-sunk text-left">
                <th className="px-4 py-2.5 font-medium text-xs text-ink-soft">Name</th>
                <th className="px-4 py-2.5 font-medium text-xs text-ink-soft hidden sm:table-cell">Age</th>
                <th className="px-4 py-2.5 font-medium text-xs text-ink-soft hidden md:table-cell">Policies</th>
                <th className="px-4 py-2.5 font-medium text-xs text-ink-soft hidden md:table-cell">Status</th>
                <th className="px-4 py-2.5 font-medium text-xs text-ink-soft">Last contact</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {clients.map((c) => {
                const since = daysSince(c.last_contacted_at);
                const overdue = since != null && since > c.review_interval_days;
                const policyCount = c.policies?.[0]?.count ?? 0;

                return (
                  <tr key={c.id} className="hover:bg-surface-sunk transition-colors">
                    <td className="px-4 py-2.5">
                      <Link href={`/clients/${c.id}`} className="font-medium hover:underline">
                        {c.preferred_name || c.full_name}
                      </Link>
                      {c.preferred_name && c.preferred_name !== c.full_name && (
                        <span className="text-ink-faint text-xs"> · {c.full_name}</span>
                      )}
                      {c.occupation && (
                        <div className="text-xs text-ink-faint sm:hidden">{c.occupation}</div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-ink-soft tabular-nums hidden sm:table-cell">
                      {age(c.dob) ?? "—"}
                    </td>
                    <td className="px-4 py-2.5 text-ink-soft tabular-nums hidden md:table-cell">
                      {policyCount}
                    </td>
                    <td className="px-4 py-2.5 hidden md:table-cell">
                      <span className="chip bg-surface-sunk text-ink-soft">
                        {labelFor(CLIENT_STATUSES, c.status)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      {since == null ? (
                        <span className="text-alert text-xs font-medium">never</span>
                      ) : (
                        <span
                          className={`text-xs tabular-nums ${
                            overdue ? "text-warn font-medium" : "text-ink-soft"
                          }`}
                        >
                          {since} days
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {clients.length === 500 && (
        <p className="mt-3 text-xs text-ink-faint text-center">
          Showing the first 500. Search to narrow it down.
        </p>
      )}
    </Shell>
  );
}
