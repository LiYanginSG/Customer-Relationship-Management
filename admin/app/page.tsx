/**
 * Today -- the dashboard.
 *
 * Deliberately built on the SAME build_daily_briefing() function the Telegram
 * bot uses. One definition of "what matters today", so the portal and the 7am
 * message can never disagree with each other.
 */

import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Shell } from "@/components/Shell";
import { formatDateShort, money, relativeDays } from "@/lib/format";

export const dynamic = "force-dynamic";

interface Briefing {
  birthdays: Array<{
    client_id: string; client_name: string; display_name: string;
    whose: string; relationship: string | null; days_away: number; turning: number;
  }>;
  premiums_due: Array<{
    client_id: string; display_name: string; insurer: string; plan_name: string;
    premium_amount: number; next_premium_due: string; days_away: number;
    paid_from_cpf: boolean;
  }>;
  anniversaries: Array<{
    client_id: string; display_name: string; plan_name: string;
    days_away: number; years_in_force: number; last_reviewed_at: string | null;
  }>;
  gone_quiet: Array<{
    client_id: string; display_name: string; days_since_contact: number | null;
    total_premium: number | null;
  }>;
  actions_due: Array<{
    client_id: string | null; display_name: string | null;
    title: string; due_date: string; days_away: number;
  }>;
  counts: {
    clients: number; policies_in_force: number;
    open_actions: number; overdue_actions: number;
  };
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="card px-4 py-3">
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 text-xs text-ink-soft">{label}</div>
    </div>
  );
}

function Section({
  title, tone = "normal", children, empty,
}: {
  title: string;
  tone?: "normal" | "alert";
  children: React.ReactNode;
  empty?: boolean;
}) {
  if (empty) return null;
  return (
    <section className="card overflow-hidden">
      <h2
        className={`px-4 py-2.5 text-xs font-semibold uppercase tracking-wide border-b border-line ${
          tone === "alert" ? "text-alert bg-alert/5" : "text-ink-soft bg-surface-sunk"
        }`}
      >
        {title}
      </h2>
      <ul className="divide-y divide-line">{children}</ul>
    </section>
  );
}

function Row({ href, children }: { href?: string; children: React.ReactNode }) {
  const inner = <div className="px-4 py-3 text-sm">{children}</div>;
  return (
    <li className={href ? "hover:bg-surface-sunk transition-colors" : ""}>
      {href ? <Link href={href} className="block">{inner}</Link> : inner}
    </li>
  );
}

export default async function TodayPage() {
  const user = await requireUser();

  const { data, error } = await db().rpc("build_daily_briefing", {
    birthday_horizon_days: 14,
    premium_horizon_days: 21,
    anniversary_horizon_days: 21,
    quiet_limit: 8,
  });

  if (error) {
    return (
      <Shell email={user.email} title="Today">
        <div className="card p-5">
          <p className="text-sm text-alert font-medium">Could not load your briefing.</p>
          <p className="mt-1.5 text-sm text-ink-soft">{error.message}</p>
          <p className="mt-3 text-xs text-ink-faint">
            This usually means the database migrations have not all been run. Check that
            0005_briefing_builder.sql was applied.
          </p>
        </div>
      </Shell>
    );
  }

  const b = data as Briefing;
  const overduePremiums = b.premiums_due.filter((p) => p.days_away < 0);
  const upcomingPremiums = b.premiums_due.filter((p) => p.days_away >= 0);
  const nothingAtAll =
    b.premiums_due.length === 0 && b.birthdays.length === 0 &&
    b.actions_due.length === 0 && b.anniversaries.length === 0 &&
    b.gone_quiet.length === 0;

  return (
    <Shell email={user.email} title="Today">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <Stat label="Clients" value={b.counts.clients} />
        <Stat label="Policies in force" value={b.counts.policies_in_force} />
        <Stat label="Open follow-ups" value={b.counts.open_actions} />
        <Stat label="Overdue" value={b.counts.overdue_actions} />
      </div>

      {nothingAtAll ? (
        <div className="card p-8 text-center">
          <p className="text-sm font-medium">Nothing pressing today.</p>
          <p className="mt-1.5 text-sm text-ink-soft">
            No premiums due, no birthdays, nothing overdue.
          </p>
          <Link href="/clients" className="btn-quiet mt-5">Browse clients</Link>
        </div>
      ) : (
        <div className="space-y-5">
          <Section title="Premiums overdue — lapse risk" tone="alert" empty={overduePremiums.length === 0}>
            {overduePremiums.map((p, i) => (
              <Row key={i} href={`/clients/${p.client_id}`}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-medium">{p.display_name}</span>
                  <span className="text-alert font-medium text-xs whitespace-nowrap">
                    {Math.abs(p.days_away)} days late
                  </span>
                </div>
                <div className="mt-0.5 text-ink-soft text-xs">
                  {p.insurer} {p.plan_name} · {money(p.premium_amount)}
                  {p.paid_from_cpf && " · CPF-funded, check the account balance"}
                </div>
              </Row>
            ))}
          </Section>

          <Section title="You promised" empty={b.actions_due.length === 0}>
            {b.actions_due.map((a, i) => (
              <Row key={i} href={a.client_id ? `/clients/${a.client_id}` : undefined}>
                <div className="flex items-baseline justify-between gap-3">
                  <span>
                    {a.display_name && (
                      <span className="font-medium">{a.display_name}: </span>
                    )}
                    {a.title}
                  </span>
                  <span
                    className={`text-xs whitespace-nowrap ${
                      a.days_away < 0 ? "text-alert font-medium" : "text-ink-soft"
                    }`}
                  >
                    {a.days_away < 0
                      ? `${Math.abs(a.days_away)} days overdue`
                      : relativeDays(a.days_away)}
                  </span>
                </div>
              </Row>
            ))}
          </Section>

          <Section title="Premiums due" empty={upcomingPremiums.length === 0}>
            {upcomingPremiums.map((p, i) => (
              <Row key={i} href={`/clients/${p.client_id}`}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-medium">{p.display_name}</span>
                  <span className="text-xs text-ink-soft whitespace-nowrap">
                    {relativeDays(p.days_away)} · {formatDateShort(p.next_premium_due)}
                  </span>
                </div>
                <div className="mt-0.5 text-ink-soft text-xs">
                  {p.insurer} {p.plan_name} · {money(p.premium_amount)}
                </div>
              </Row>
            ))}
          </Section>

          <Section title="Birthdays" empty={b.birthdays.length === 0}>
            {b.birthdays.map((x, i) => (
              <Row key={i} href={`/clients/${x.client_id}`}>
                <div className="flex items-baseline justify-between gap-3">
                  <span>
                    <span className="font-medium">{x.display_name}</span>
                    {x.whose === "family" && (
                      <span className="text-ink-soft text-xs">
                        {" "}— {x.client_name}&apos;s {x.relationship}
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-ink-soft whitespace-nowrap">
                    turns {x.turning} {relativeDays(x.days_away)}
                  </span>
                </div>
              </Row>
            ))}
          </Section>

          <Section title="Policy anniversaries" empty={b.anniversaries.length === 0}>
            {b.anniversaries.map((a, i) => (
              <Row key={i} href={`/clients/${a.client_id}`}>
                <div className="flex items-baseline justify-between gap-3">
                  <span>
                    <span className="font-medium">{a.display_name}</span>
                    <span className="text-ink-soft"> — {a.plan_name}</span>
                  </span>
                  <span className="text-xs text-ink-soft whitespace-nowrap">
                    year {a.years_in_force} {relativeDays(a.days_away)}
                  </span>
                </div>
                {!a.last_reviewed_at && (
                  <div className="mt-0.5 text-xs text-warn">Never reviewed</div>
                )}
              </Row>
            ))}
          </Section>

          <Section title="Gone quiet" empty={b.gone_quiet.length === 0}>
            {b.gone_quiet.map((c, i) => (
              <Row key={i} href={`/clients/${c.client_id}`}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-medium">{c.display_name}</span>
                  <span className="text-xs text-ink-soft whitespace-nowrap">
                    {c.days_since_contact == null
                      ? "never contacted"
                      : `${c.days_since_contact} days`}
                    {c.total_premium ? ` · ${money(c.total_premium)}` : ""}
                  </span>
                </div>
              </Row>
            ))}
          </Section>
        </div>
      )}
    </Shell>
  );
}
