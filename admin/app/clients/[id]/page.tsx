import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Shell } from "@/components/Shell";
import { ClientForm } from "@/components/ClientForm";
import { PolicyForm } from "@/components/PolicyForm";
import { NoteForm } from "@/components/NoteForm";
import { FamilyForm } from "@/components/FamilyForm";
import { ActionForm } from "@/components/ActionForm";
import { Disclosure } from "@/components/Disclosure";
import { ExtraFields } from "@/components/ExtraFields";
import { PolicyCard } from "@/components/PolicyCard";
import { completeAction, deleteFamilyMember } from "@/lib/actions";
import {
  age, annualisedPremium, formatDate, formatDateTime, labelFor, money,
  sgToday, CLIENT_STATUSES, RESIDENCY, RELATIONSHIPS, CHANNELS,
} from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function ClientPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;

  const [clientRes, policyRes, familyRes, notesRes, actionRes] = await Promise.all([
    db().from("clients").select("*").eq("id", id).maybeSingle(),
    db().from("policies").select("*").eq("client_id", id)
      .order("inception_date", { ascending: false, nullsFirst: false }),
    db().from("family_members").select("*").eq("client_id", id).order("dob"),
    db().from("interactions").select("*").eq("client_id", id)
      .order("occurred_at", { ascending: false }).limit(50),
    db().from("action_items").select("*").eq("client_id", id)
      .eq("status", "open").order("due_date", { nullsFirst: false }),
  ]);

  const client = clientRes.data;
  if (!client) notFound();

  const policies = policyRes.data ?? [];
  const family = familyRes.data ?? [];
  const notes = notesRes.data ?? [];
  const actions = actionRes.data ?? [];
  const today = sgToday();

  const inForce = policies.filter((p) => p.status === "in_force");
  const annualised = inForce.reduce(
    (sum, p) => sum + annualisedPremium(p.premium_amount, p.premium_mode), 0,
  );
  const deathCover = inForce
    .filter((p) => ["term_life", "whole_life"].includes(String(p.policy_type)))
    .reduce((sum, p) => sum + Number(p.sum_assured ?? 0), 0);

  const daysSinceContact = client.last_contacted_at
    ? Math.floor((Date.now() - new Date(client.last_contacted_at).getTime()) / 86400000)
    : null;
  const contactOverdue =
    daysSinceContact != null && daysSinceContact > client.review_interval_days;

  return (
    <Shell email={user.email}>
      <div className="mb-5">
        <Link href="/clients" className="text-sm text-ink-soft hover:text-ink">
          ← Clients
        </Link>
        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-lg font-semibold tracking-tight">
            {client.preferred_name || client.full_name}
          </h1>
          {client.preferred_name && client.preferred_name !== client.full_name && (
            <span className="text-sm text-ink-faint">{client.full_name}</span>
          )}
          <span className="chip bg-surface-sunk text-ink-soft">
            {labelFor(CLIENT_STATUSES, client.status)}
          </span>
        </div>
        <p className="mt-1 text-sm text-ink-soft">
          {[
            age(client.dob) != null ? `${age(client.dob)} years old` : null,
            labelFor(RESIDENCY, client.residency) !== "Not known"
              ? labelFor(RESIDENCY, client.residency) : null,
            client.occupation,
            client.phone,
          ].filter(Boolean).join(" · ")}
        </p>
      </div>

      {/* --- at a glance --- */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <div className="card px-4 py-3">
          <div className="text-xl font-semibold tabular-nums">{inForce.length}</div>
          <div className="mt-0.5 text-xs text-ink-soft">Policies in force</div>
        </div>
        <div className="card px-4 py-3">
          <div className="text-xl font-semibold tabular-nums">{money(annualised)}</div>
          <div className="mt-0.5 text-xs text-ink-soft">Annualised premium</div>
        </div>
        <div className="card px-4 py-3">
          <div className="text-xl font-semibold tabular-nums">{money(deathCover)}</div>
          <div className="mt-0.5 text-xs text-ink-soft">Death cover</div>
        </div>
        <div className="card px-4 py-3">
          <div
            className={`text-xl font-semibold tabular-nums ${
              daysSinceContact == null ? "text-alert" : contactOverdue ? "text-warn" : ""
            }`}
          >
            {daysSinceContact == null ? "Never" : `${daysSinceContact}d`}
          </div>
          <div className="mt-0.5 text-xs text-ink-soft">
            Since contact{contactOverdue ? " · overdue" : ""}
          </div>
        </div>
      </div>

      {client.profile_notes && (
        <div className="card p-4 mb-6 bg-surface-sunk">
          <div className="text-xs font-medium text-ink-soft mb-1">Standing notes</div>
          <p className="text-sm whitespace-pre-wrap">{client.profile_notes}</p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ---------------- left: policies and timeline ---------------- */}
        <div className="lg:col-span-2 space-y-6">
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold">Policies</h2>
            </div>

            {policies.length === 0 ? (
              <div className="card p-6 text-center text-sm text-ink-soft">
                No policies recorded yet.
              </div>
            ) : (
              <div className="space-y-3">
                {policies.map((p) => (
                  <PolicyCard key={p.id} policy={p} clientId={id} />
                ))}
              </div>
            )}

            <div className="mt-3">
              <Disclosure label="Add a policy">
                <PolicyForm clientId={id} />
              </Disclosure>
            </div>
          </section>

          <section>
            <h2 className="text-sm font-semibold mb-3">File a note</h2>
            <div className="card p-5">
              <NoteForm clientId={id} today={today} />
            </div>
          </section>

          <section>
            <h2 className="text-sm font-semibold mb-3">
              Timeline
              {notes.length > 0 && (
                <span className="ml-2 text-xs font-normal text-ink-faint">
                  {notes.length}
                </span>
              )}
            </h2>

            {notes.length === 0 ? (
              <div className="card p-6 text-center text-sm text-ink-soft">
                Nothing recorded yet.
              </div>
            ) : (
              <ol className="space-y-2">
                {notes.map((n) => (
                  <li key={n.id} className="card p-4">
                    <div className="flex items-baseline justify-between gap-3 mb-1">
                      <span className="text-xs text-ink-soft">
                        {labelFor(CHANNELS, n.channel)} · {formatDateTime(n.occurred_at)}
                      </span>
                      {n.ai_generated && (
                        <span
                          className="chip bg-calm/10 text-calm shrink-0"
                          title="Written by the Telegram manager from what you dictated, rather than typed by you"
                        >
                          via manager
                        </span>
                      )}
                    </div>
                    <p className="text-sm">{n.summary}</p>
                    {n.detail && (
                      <p className="mt-1.5 text-sm text-ink-soft whitespace-pre-wrap">
                        {n.detail}
                      </p>
                    )}
                    {n.topics && n.topics.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {n.topics.map((t: string) => (
                          <span key={t} className="chip bg-surface-sunk text-ink-soft">
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        {/* ---------------- right: family, follow-ups, details ---------------- */}
        <div className="space-y-6">
          <section>
            <h2 className="text-sm font-semibold mb-3">
              Open follow-ups
              {actions.length > 0 && (
                <span className="ml-2 text-xs font-normal text-ink-faint">
                  {actions.length}
                </span>
              )}
            </h2>

            {actions.length === 0 ? (
              <div className="card p-4 text-sm text-ink-soft">Nothing outstanding.</div>
            ) : (
              <ul className="card divide-y divide-line">
                {actions.map((a) => {
                  const overdue = a.due_date && a.due_date < today;
                  return (
                    <li key={a.id} className="p-3.5 flex items-start gap-3">
                      <form action={completeAction} className="shrink-0 pt-0.5">
                        <input type="hidden" name="action_id" value={a.id} />
                        <input type="hidden" name="client_id" value={id} />
                        <button
                          type="submit"
                          title="Mark done"
                          className="h-4 w-4 rounded border border-line hover:border-good hover:bg-good/10 transition-colors"
                        />
                      </form>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm">{a.title}</p>
                        {a.due_date && (
                          <p className={`text-xs mt-0.5 ${overdue ? "text-alert font-medium" : "text-ink-soft"}`}>
                            {overdue ? "Overdue · " : "Due "}{formatDate(a.due_date)}
                          </p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="mt-3">
              <Disclosure label="Add follow-up">
                <ActionForm clientId={id} />
              </Disclosure>
            </div>
          </section>

          <section>
            <h2 className="text-sm font-semibold mb-3">Family</h2>

            {family.length === 0 ? (
              <div className="card p-4 text-sm text-ink-soft">Nobody recorded.</div>
            ) : (
              <ul className="card divide-y divide-line">
                {family.map((f) => (
                  <li key={f.id} className="p-3.5 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm">
                        {f.name || labelFor(RELATIONSHIPS, f.relationship)}
                        <span className="text-ink-faint text-xs">
                          {" "}· {labelFor(RELATIONSHIPS, f.relationship)}
                        </span>
                      </p>
                      <p className="text-xs text-ink-soft mt-0.5">
                        {f.dob ? `${formatDate(f.dob)} · ${age(f.dob)} years` : "No date of birth"}
                        {f.is_dependent && " · dependent"}
                      </p>
                      {f.is_dependent && !f.is_insured && (
                        <p className="text-xs text-warn mt-0.5">No cover recorded</p>
                      )}
                    </div>
                    <form action={deleteFamilyMember} className="shrink-0">
                      <input type="hidden" name="family_member_id" value={f.id} />
                      <input type="hidden" name="client_id" value={id} />
                      <button type="submit" className="text-xs text-ink-faint hover:text-alert">
                        Remove
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-3">
              <Disclosure label="Add family member">
                <FamilyForm clientId={id} />
              </Disclosure>
            </div>
          </section>

          <section>
            <h2 className="text-sm font-semibold mb-3">Details</h2>
            <dl className="card p-4 space-y-2.5 text-sm">
              {[
                ["Date of birth", formatDate(client.dob)],
                ["Email", client.email ?? "—"],
                ["Employer", client.employer ?? "—"],
                ["Annual income", money(client.annual_income)],
                ["Area", client.address_area ?? "—"],
                ["Client since", formatDate(client.client_since)],
                ["Contact every", `${client.review_interval_days} days`],
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between gap-3">
                  <dt className="text-ink-soft shrink-0">{label}</dt>
                  <dd className="text-right min-w-0 break-words">{value}</dd>
                </div>
              ))}
            </dl>

            <div className="mt-3">
              <Disclosure label="Edit client details">
                <ClientForm client={client} />
              </Disclosure>
            </div>
          </section>

          <ExtraFields
            title="From your export"
            extra={client.extra}
            note="Columns your portal export contained that have no field of their own yet. Nothing is lost \u2014 tell Claude what these are and they can be given proper columns."
          />
        </div>
      </div>
    </Shell>
  );
}
