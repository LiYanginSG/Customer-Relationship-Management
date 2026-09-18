/**
 * staff/tools.ts -- the database lookups the staff are allowed to perform.
 *
 * Each tool is deliberately narrow. A staff member holds only the tools for
 * their own desk, which means the birthday clerk genuinely cannot read a policy
 * contract, and the product desk genuinely cannot see your client list. That
 * is not decoration: it keeps each agent's context small (cheaper, sharper) and
 * limits what any single confused agent can do.
 */

import { db, rpc } from "../db.ts";
import { scrubDeep } from "../nric.ts";
import type { AgentTool } from "../claude.ts";

/** Every tool result passes through here, so nothing reaches a model unscrubbed. */
async function safe<T>(fn: () => Promise<T>): Promise<T> {
  return scrubDeep(await fn());
}

// ---------------------------------------------------------------------------
// Shared: finding a person
// ---------------------------------------------------------------------------

export const findClient: AgentTool = {
  name: "find_client",
  description:
    "Find clients by name, partial name, or nickname. Use this first whenever " +
    "the adviser mentions someone by name, to get their client_id. Returns " +
    "possible matches -- if more than one comes back, ask which they meant.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Full or partial name to search for" },
    },
    required: ["name"],
    additionalProperties: false,
  },
  run: (input) =>
    safe(async () => {
      const name = String(input.name ?? "").trim();
      if (!name) return { matches: [] };

      const { data, error } = await db()
        .from("clients")
        .select(
          "id, full_name, preferred_name, dob, status, occupation, " +
            "last_contacted_at, residency, marital_status",
        )
        .ilike("full_name", `%${name}%`)
        .limit(10);

      if (error) throw new Error(error.message);
      return {
        matches: data ?? [],
        note: data?.length === 0 ? "No client by that name is on file." : undefined,
      };
    }),
};

export const getDossier: AgentTool = {
  name: "get_client_dossier",
  description:
    "Everything on file about one client: their details, family, all policies, " +
    "the last ten conversations, open follow-ups and live opportunities. " +
    "Requires a client_id from find_client.",
  input_schema: {
    type: "object",
    properties: {
      client_id: { type: "string", description: "UUID from find_client" },
    },
    required: ["client_id"],
    additionalProperties: false,
  },
  run: (input) =>
    safe(() => rpc("client_dossier", { target: String(input.client_id) })),
};

// ---------------------------------------------------------------------------
// Birthday and milestone desk
// ---------------------------------------------------------------------------

export const upcomingBirthdays: AgentTool = {
  name: "upcoming_birthdays",
  description:
    "Birthdays coming up, for clients and their family members. Family " +
    "birthdays are included because a child's birthday is often the better " +
    "reason to call, and milestone ages (1, 18, 21, 55, 65) matter for planning.",
  input_schema: {
    type: "object",
    properties: {
      days_ahead: {
        type: "integer",
        description: "How far to look ahead. Default 14, maximum 120.",
      },
    },
    required: [],
    additionalProperties: false,
  },
  run: (input) =>
    safe(async () => {
      const days = Math.min(Math.max(Number(input.days_ahead ?? 14), 0), 120);
      const { data, error } = await db()
        .from("v_upcoming_birthdays")
        .select("*")
        .gte("days_away", 0)
        .lte("days_away", days)
        .order("days_away", { ascending: true });

      if (error) throw new Error(error.message);
      return { window_days: days, birthdays: data ?? [] };
    }),
};

// ---------------------------------------------------------------------------
// Policy and premium desk
// ---------------------------------------------------------------------------

export const premiumsDue: AgentTool = {
  name: "premiums_due",
  description:
    "Premiums falling due, or already overdue. A negative days_away means the " +
    "premium is late and the policy is at risk of lapsing -- that is urgent.",
  input_schema: {
    type: "object",
    properties: {
      days_ahead: { type: "integer", description: "Default 30, maximum 180." },
      include_overdue: { type: "boolean", description: "Default true." },
    },
    required: [],
    additionalProperties: false,
  },
  run: (input) =>
    safe(async () => {
      const days = Math.min(Math.max(Number(input.days_ahead ?? 30), 0), 180);
      const includeOverdue = input.include_overdue !== false;

      let q = db().from("v_premiums_due").select("*").lte("days_away", days);
      if (!includeOverdue) q = q.gte("days_away", 0);

      const { data, error } = await q.order("days_away", { ascending: true });
      if (error) throw new Error(error.message);

      const rows = data ?? [];
      return {
        window_days: days,
        overdue_count: rows.filter((r) => Number(r.days_away) < 0).length,
        premiums: rows,
      };
    }),
};

export const policyAnniversaries: AgentTool = {
  name: "policy_anniversaries",
  description:
    "Policies reaching their inception anniversary. These are natural review " +
    "moments, and for term plans the year before a rate step-up is the moment " +
    "to act rather than after.",
  input_schema: {
    type: "object",
    properties: {
      days_ahead: { type: "integer", description: "Default 30, maximum 180." },
    },
    required: [],
    additionalProperties: false,
  },
  run: (input) =>
    safe(async () => {
      const days = Math.min(Math.max(Number(input.days_ahead ?? 30), 0), 180);
      const { data, error } = await db()
        .from("v_policy_anniversaries")
        .select("*")
        .gte("days_away", 0)
        .lte("days_away", days)
        .order("days_away", { ascending: true });

      if (error) throw new Error(error.message);
      return { window_days: days, anniversaries: data ?? [] };
    }),
};

export const listPolicies: AgentTool = {
  name: "list_policies",
  description:
    "Every policy for one client, including lapsed and matured ones. Use this " +
    "when asked what someone is covered for, or to spot a gap.",
  input_schema: {
    type: "object",
    properties: {
      client_id: { type: "string" },
      status: {
        type: "string",
        description: "Optional filter, e.g. in_force, lapsed, paid_up.",
      },
    },
    required: ["client_id"],
    additionalProperties: false,
  },
  run: (input) =>
    safe(async () => {
      let q = db()
        .from("policies")
        .select("*")
        .eq("client_id", String(input.client_id));

      if (input.status) q = q.eq("status", String(input.status));

      const { data, error } = await q.order("inception_date", { ascending: false });
      if (error) throw new Error(error.message);
      return { policies: data ?? [] };
    }),
};

export const portfolioSummary: AgentTool = {
  name: "portfolio_summary",
  description:
    "Totals across the whole book: how many clients, how many policies in " +
    "force, total annualised premium, and a breakdown by insurer and policy " +
    "type. Use for questions about the business as a whole.",
  input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  run: () =>
    safe(async () => {
      const { data, error } = await db()
        .from("policies")
        .select("insurer, policy_type, premium_amount, premium_mode, status, client_id")
        .eq("status", "in_force");

      if (error) throw new Error(error.message);
      const rows = data ?? [];

      // Annualise so that monthly and annual premiums are comparable.
      const multiplier: Record<string, number> = {
        monthly: 12, quarterly: 4, semi_annual: 2, annual: 1,
        single: 0, limited_pay: 1,
      };

      let annualised = 0;
      const byInsurer: Record<string, number> = {};
      const byType: Record<string, number> = {};

      for (const r of rows) {
        const amount = Number(r.premium_amount ?? 0);
        const annual = amount * (multiplier[String(r.premium_mode)] ?? 1);
        annualised += annual;
        byInsurer[String(r.insurer)] = (byInsurer[String(r.insurer)] ?? 0) + annual;
        byType[String(r.policy_type)] = (byType[String(r.policy_type)] ?? 0) + annual;
      }

      const { count: clientCount } = await db()
        .from("clients")
        .select("id", { count: "exact", head: true })
        .in("status", ["active", "prospect"]);

      return {
        clients: clientCount ?? 0,
        policies_in_force: rows.length,
        distinct_clients_with_cover: new Set(rows.map((r) => r.client_id)).size,
        annualised_premium: Math.round(annualised),
        by_insurer: byInsurer,
        by_policy_type: byType,
      };
    }),
};

// ---------------------------------------------------------------------------
// Sales desk -- who is worth your time this week
// ---------------------------------------------------------------------------

export const whoToSee: AgentTool = {
  name: "who_to_see",
  description:
    "A ranked list of clients worth contacting now, with the reason for each. " +
    "Scoring is done in code, not guessed: overdue contact, upcoming birthday, " +
    "premium due, policy anniversary, open promises and never-reviewed cover " +
    "all contribute. Use this for 'who should I see this week'.",
  input_schema: {
    type: "object",
    properties: {
      limit: { type: "integer", description: "How many to return. Default 8, max 25." },
    },
    required: [],
    additionalProperties: false,
  },
  run: (input) =>
    safe(async () => {
      const limit = Math.min(Math.max(Number(input.limit ?? 8), 1), 25);

      // Pull the signals in parallel, then score. Doing the arithmetic here
      // rather than asking the model to do it means the ranking is consistent
      // and explainable -- you can audit why someone is at the top.
      const [quiet, birthdays, premiums, anniversaries, actions] = await Promise.all([
        db().from("v_clients_gone_quiet").select("*"),
        db().from("v_upcoming_birthdays").select("*").gte("days_away", 0).lte("days_away", 14),
        db().from("v_premiums_due").select("*").lte("days_away", 21),
        db().from("v_policy_anniversaries").select("*").gte("days_away", 0).lte("days_away", 21),
        db().from("v_open_actions").select("*"),
      ]);

      interface Candidate {
        client_id: string;
        name: string;
        score: number;
        reasons: string[];
        phone?: string;
      }
      const pool = new Map<string, Candidate>();

      const add = (
        id: string | null | undefined,
        name: string,
        points: number,
        reason: string,
        phone?: string,
      ) => {
        if (!id) return;
        const existing = pool.get(id);
        if (existing) {
          existing.score += points;
          existing.reasons.push(reason);
        } else {
          pool.set(id, { client_id: id, name, score: points, reasons: [reason], phone });
        }
      };

      for (const r of quiet.data ?? []) {
        const overdue = Number(r.days_overdue);
        // Never contacted is its own category, not just "very overdue".
        const points = overdue >= 9999 ? 45 : Math.min(40, 12 + overdue / 15);
        const label = overdue >= 9999
          ? "never contacted since being added"
          : `${r.days_since_contact} days since last contact (${r.days_overdue} past your own cadence)`;
        add(r.client_id, String(r.client_name), points, label, r.phone as string);
      }

      for (const r of birthdays.data ?? []) {
        const whose = r.whose === "family"
          ? `${r.display_name}'s birthday (${r.relationship})`
          : "birthday";
        add(
          r.client_id,
          String(r.client_name),
          r.whose === "family" ? 14 : 20,
          `${whose} in ${r.days_away} days, turning ${r.turning}`,
          r.phone as string,
        );
      }

      for (const r of premiums.data ?? []) {
        const days = Number(r.days_away);
        add(
          r.client_id,
          String(r.client_name),
          days < 0 ? 50 : 22,   // overdue premium is the most urgent thing here
          days < 0
            ? `PREMIUM OVERDUE ${Math.abs(days)} days: ${r.insurer} ${r.plan_name}, $${r.premium_amount} -- lapse risk`
            : `premium due in ${days} days: ${r.insurer} ${r.plan_name}, $${r.premium_amount}`,
          r.phone as string,
        );
      }

      for (const r of anniversaries.data ?? []) {
        const neverReviewed = r.last_reviewed_at == null;
        add(
          r.client_id,
          String(r.client_name),
          neverReviewed ? 26 : 16,
          `${r.plan_name} hits year ${r.years_in_force} in ${r.days_away} days` +
            (neverReviewed ? " and has never been reviewed" : ""),
          undefined,
        );
      }

      for (const r of actions.data ?? []) {
        const days = Number(r.days_away ?? 0);
        if (r.due_date && days < 0) {
          add(
            r.client_id as string,
            String(r.client_name ?? "unknown"),
            30,
            `you promised: "${r.title}" -- ${Math.abs(days)} days overdue`,
          );
        }
      }

      const ranked = [...pool.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((c) => ({
          client_id: c.client_id,
          name: c.name,
          priority_score: Math.round(c.score),
          reasons: c.reasons,
          phone: c.phone,
        }));

      return {
        generated: new Date().toISOString(),
        scoring_note:
          "Scores are computed in code from real signals. Overdue premiums and " +
          "broken promises rank highest because both cost trust.",
        candidates: ranked,
      };
    }),
};

export const coverageGaps: AgentTool = {
  name: "coverage_gaps",
  description:
    "Structural gaps in a client's cover: no hospital plan, no critical " +
    "illness, no disability income, dependants with no protection, or cover " +
    "that has not moved since a major life event. Returns the facts -- you " +
    "judge whether a gap is worth raising.",
  input_schema: {
    type: "object",
    properties: {
      client_id: { type: "string" },
    },
    required: ["client_id"],
    additionalProperties: false,
  },
  run: (input) =>
    safe(async () => {
      const clientId = String(input.client_id);

      const [clientRes, policyRes, familyRes] = await Promise.all([
        db().from("clients").select("*").eq("id", clientId).maybeSingle(),
        db().from("policies").select("*").eq("client_id", clientId).eq("status", "in_force"),
        db().from("family_members").select("*").eq("client_id", clientId),
      ]);

      const client = clientRes.data;
      if (!client) throw new Error("No such client.");

      const policies = policyRes.data ?? [];
      const family = familyRes.data ?? [];
      const types = new Set(policies.map((p) => String(p.policy_type)));

      const gaps: string[] = [];

      if (!types.has("hospital")) {
        gaps.push(
          "No hospital or Integrated Shield plan on file. Worth confirming " +
            "whether they hold one elsewhere -- MediShield Life alone leaves a " +
            "large gap for private care.",
        );
      }
      if (!types.has("ci_standalone") && !policies.some((p) => (p.riders ?? []).length > 0)) {
        gaps.push("No critical illness cover on file, and no riders recorded.");
      }
      if (!types.has("disability")) {
        gaps.push("No disability income cover on file.");
      }
      if (!types.has("term_life") && !types.has("whole_life")) {
        gaps.push("No death cover on file at all.");
      }

      const dependants = family.filter((f) => f.is_dependent);
      const uninsuredDependants = dependants.filter((f) => !f.is_insured);
      if (uninsuredDependants.length > 0) {
        gaps.push(
          `${uninsuredDependants.length} dependant(s) with no cover recorded: ` +
            uninsuredDependants.map((f) => f.name ?? f.relationship).join(", "),
        );
      }

      // Protection-gap benchmarks from the LIA Singapore Protection Gap Study:
      // 9x annual income for death and TPD, 4x for critical illness. These are
      // the figures the insurers' own tools quote, so using anything else puts
      // this system at odds with the illustration the client is holding.
      const LIA_DEATH_MULTIPLE = 9;
      const LIA_CI_MULTIPLE = 4;

      const sumFor = (types: string[]) =>
        policies
          .filter((p) => types.includes(String(p.policy_type)))
          .reduce((sum, p) => sum + Number(p.sum_assured ?? 0), 0);

      const deathCover = sumFor(["term_life", "whole_life"]);
      const ciCover = sumFor(["ci_standalone"]);

      const income = Number(client.annual_income ?? 0);
      let coverMultiple: number | null = null;
      let recommendedDeath: number | null = null;
      let recommendedCi: number | null = null;

      if (income > 0) {
        recommendedDeath = income * LIA_DEATH_MULTIPLE;
        recommendedCi = income * LIA_CI_MULTIPLE;

        if (deathCover > 0) coverMultiple = Number((deathCover / income).toFixed(1));

        if (deathCover < recommendedDeath) {
          gaps.push(
            `Death cover is ${deathCover.toLocaleString()} against an LIA benchmark of ` +
              `${recommendedDeath.toLocaleString()} (9x income). Shortfall ` +
              `${(recommendedDeath - deathCover).toLocaleString()}.`,
          );
        }
        if (ciCover < recommendedCi) {
          gaps.push(
            `Critical illness cover is ${ciCover.toLocaleString()} against an LIA ` +
              `benchmark of ${recommendedCi.toLocaleString()} (4x income). Shortfall ` +
              `${(recommendedCi - ciCover).toLocaleString()}.`,
          );
        }
      } else {
        gaps.push(
          "No annual income on file, so the protection-gap benchmarks cannot be " +
            "calculated. Worth adding -- it is what the 9x and 4x figures multiply.",
        );
      }

      const stale = policies.filter((p) => {
        if (!p.last_reviewed_at) return true;
        const days = (Date.now() - new Date(String(p.last_reviewed_at)).getTime()) / 86400000;
        return days > 730;
      });

      return {
        client: {
          name: client.full_name,
          residency: client.residency,
          marital_status: client.marital_status,
          annual_income: client.annual_income,
          dependants: dependants.length,
        },
        policies_in_force: policies.length,
        policy_types_held: [...types],
        total_death_cover: deathCover,
        total_ci_cover: ciCover,
        cover_multiple_of_income: coverMultiple,
        lia_benchmark_death: recommendedDeath,
        lia_benchmark_ci: recommendedCi,
        benchmark_source:
          "LIA Singapore Protection Gap Study: 9x annual income for death and TPD, " +
          "4x for critical illness. The same basis the insurers' own portfolio " +
          "summaries quote.",
        never_or_long_unreviewed: stale.map((p) => `${p.insurer} ${p.plan_name}`),
        gaps,
        caution:
          "These are data observations, not recommendations. Suitability depends " +
          "on facts not in this database.",
      };
    }),
};

export const listOpportunities: AgentTool = {
  name: "list_opportunities",
  description: "Open and in-progress opportunities across the book.",
  input_schema: {
    type: "object",
    properties: {
      client_id: { type: "string", description: "Optional: limit to one client." },
      status: { type: "string", description: "Default open and working." },
    },
    required: [],
    additionalProperties: false,
  },
  run: (input) =>
    safe(async () => {
      let q = db()
        .from("opportunities")
        .select("*, clients(full_name, preferred_name)");

      if (input.client_id) q = q.eq("client_id", String(input.client_id));
      q = input.status
        ? q.eq("status", String(input.status))
        : q.in("status", ["open", "working"]);

      const { data, error } = await q.order("next_step_date", {
        ascending: true,
        nullsFirst: false,
      });
      if (error) throw new Error(error.message);
      return { opportunities: data ?? [] };
    }),
};

// ---------------------------------------------------------------------------
// Relationship desk -- what you actually talked about
// ---------------------------------------------------------------------------

export const recentConversations: AgentTool = {
  name: "recent_conversations",
  description:
    "What was discussed with a client, most recent first. Use this before any " +
    "meeting so you walk in knowing what you said last time and what you " +
    "promised. Without a client_id, returns recent conversations across everyone.",
  input_schema: {
    type: "object",
    properties: {
      client_id: { type: "string", description: "Optional: one client only." },
      limit: { type: "integer", description: "Default 10, max 40." },
    },
    required: [],
    additionalProperties: false,
  },
  run: (input) =>
    safe(async () => {
      const limit = Math.min(Math.max(Number(input.limit ?? 10), 1), 40);
      let q = db()
        .from("interactions")
        .select("id, client_id, occurred_at, channel, summary, detail, topics, sentiment, ai_generated, clients(full_name)");

      if (input.client_id) q = q.eq("client_id", String(input.client_id));

      const { data, error } = await q
        .order("occurred_at", { ascending: false })
        .limit(limit);

      if (error) throw new Error(error.message);
      return { conversations: data ?? [] };
    }),
};

export const searchNotes: AgentTool = {
  name: "search_notes",
  description:
    "Search across every meeting note for a word or phrase. Use for questions " +
    "like 'who mentioned retiring early' or 'which clients talked about their " +
    "children's education'.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Word or phrase to look for." },
      limit: { type: "integer", description: "Default 15, max 40." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  run: (input) =>
    safe(async () => {
      const query = String(input.query ?? "").trim();
      const limit = Math.min(Math.max(Number(input.limit ?? 15), 1), 40);
      if (!query) return { results: [] };

      const { data, error } = await db()
        .from("interactions")
        .select("id, client_id, occurred_at, channel, summary, detail, topics, clients(full_name)")
        .or(`summary.ilike.%${query}%,detail.ilike.%${query}%`)
        .order("occurred_at", { ascending: false })
        .limit(limit);

      if (error) throw new Error(error.message);
      return { query, results: data ?? [] };
    }),
};

export const openPromises: AgentTool = {
  name: "open_promises",
  description:
    "Things you said you would do and have not closed off. Overdue ones are " +
    "listed first, because those are the ones that cost trust.",
  input_schema: {
    type: "object",
    properties: {
      client_id: { type: "string", description: "Optional: one client only." },
    },
    required: [],
    additionalProperties: false,
  },
  run: (input) =>
    safe(async () => {
      let q = db().from("v_open_actions").select("*");
      if (input.client_id) q = q.eq("client_id", String(input.client_id));

      const { data, error } = await q.order("due_date", {
        ascending: true,
        nullsFirst: false,
      });
      if (error) throw new Error(error.message);

      const rows = data ?? [];
      return {
        overdue: rows.filter((r) => r.days_away != null && Number(r.days_away) < 0),
        upcoming: rows.filter((r) => r.days_away == null || Number(r.days_away) >= 0),
      };
    }),
};

// ---------------------------------------------------------------------------
// Product desk -- the library
// ---------------------------------------------------------------------------

export const searchProducts: AgentTool = {
  name: "search_product_documents",
  description:
    "Search the uploaded product summaries, brochures and policy contracts. " +
    "Returns the actual text of the matching passages along with which document " +
    "and page they came from. ALWAYS quote from what comes back and name the " +
    "document -- never answer a product question from memory.\n\n" +
    "Each result carries a match_type. 'exact' means every search term was " +
    "found. 'partial' means only some were, so read the passage carefully " +
    "before relying on it and tell the manager it was a loose match.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Search terms. Insurance wording is precise, so prefer exact terms " +
          "like 'deferment period' or 'pre-existing condition exclusion'.",
      },
      insurer: { type: "string", description: "Optional insurer filter." },
      max_results: { type: "integer", description: "Default 8, max 20." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  run: (input) =>
    safe(async () => {
      const results = await rpc<unknown[]>("search_products", {
        query_text: String(input.query),
        insurer_filter: input.insurer ? String(input.insurer) : null,
        max_results: Math.min(Math.max(Number(input.max_results ?? 8), 1), 20),
      });
      return {
        query: input.query,
        passages: results ?? [],
        note: (results ?? []).length === 0
          ? "Nothing in the library matches. The document may not be uploaded yet."
          : undefined,
      };
    }),
};

export const listProducts: AgentTool = {
  name: "list_product_documents",
  description:
    "What is actually in the product library: which documents have been " +
    "uploaded, for which insurer, and whether they are current or superseded.",
  input_schema: {
    type: "object",
    properties: {
      insurer: { type: "string", description: "Optional insurer filter." },
    },
    required: [],
    additionalProperties: false,
  },
  run: (input) =>
    safe(async () => {
      let q = db()
        .from("products")
        .select("id, insurer, name, product_type, doc_type, status, effective_date, page_count, ingested_at");

      if (input.insurer) q = q.ilike("insurer", `%${input.insurer}%`);

      const { data, error } = await q.order("insurer").order("name");
      if (error) throw new Error(error.message);
      return { documents: data ?? [] };
    }),
};

// ---------------------------------------------------------------------------
// Write tools -- filing what you tell the manager
//
// These are the only tools that change anything. They are held by the manager
// alone, not handed out to the read-only desks, so that a lookup agent can
// never modify your client book as a side effect of answering a question.
// ---------------------------------------------------------------------------

export const logInteraction: AgentTool = {
  name: "log_interaction",
  description:
    "File a meeting, call or conversation against a client. Use this whenever " +
    "the adviser tells you about something that happened -- 'just saw Mr Tan', " +
    "'called Sarah about her renewal'. Write the summary in the adviser's own " +
    "words as far as possible.",
  input_schema: {
    type: "object",
    properties: {
      client_id: { type: "string" },
      summary: {
        type: "string",
        description: "One or two lines. This is what gets re-read before the next meeting.",
      },
      detail: { type: "string", description: "The fuller note, if there is one." },
      channel: {
        type: "string",
        enum: ["meeting", "call", "whatsapp", "email", "telegram", "event", "note", "other"],
      },
      topics: {
        type: "array",
        items: { type: "string" },
        description: "Short tags, e.g. ['retirement', 'cpf_sa_topup', 'newborn'].",
      },
      sentiment: {
        type: "string",
        enum: ["positive", "neutral", "concerned", "negative"],
      },
      occurred_at: {
        type: "string",
        description: "ISO timestamp. Defaults to now if the adviser did not say when.",
      },
    },
    required: ["client_id", "summary"],
    additionalProperties: false,
  },
  run: (input) =>
    safe(async () => {
      const { data, error } = await db()
        .from("interactions")
        .insert({
          client_id: String(input.client_id),
          summary: String(input.summary),
          detail: input.detail ? String(input.detail) : null,
          channel: input.channel ? String(input.channel) : "meeting",
          topics: Array.isArray(input.topics) ? input.topics.map(String) : null,
          sentiment: input.sentiment ? String(input.sentiment) : null,
          occurred_at: input.occurred_at ? String(input.occurred_at) : new Date().toISOString(),
          ai_generated: true,
        })
        .select("id, occurred_at")
        .single();

      if (error) throw new Error(error.message);
      return { filed: true, interaction_id: data.id, occurred_at: data.occurred_at };
    }),
};

export const createAction: AgentTool = {
  name: "create_action_item",
  description:
    "Record something the adviser needs to do. Create one whenever a promise " +
    "is implied -- 'I'll send him the quote', 'need to check her Shield tier'.",
  input_schema: {
    type: "object",
    properties: {
      client_id: { type: "string", description: "Optional if not client-specific." },
      title: { type: "string", description: "Short and actionable." },
      detail: { type: "string" },
      due_date: { type: "string", description: "YYYY-MM-DD." },
      priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
    },
    required: ["title"],
    additionalProperties: false,
  },
  run: (input) =>
    safe(async () => {
      const { data, error } = await db()
        .from("action_items")
        .insert({
          client_id: input.client_id ? String(input.client_id) : null,
          title: String(input.title),
          detail: input.detail ? String(input.detail) : null,
          due_date: input.due_date ? String(input.due_date) : null,
          priority: input.priority ? String(input.priority) : "normal",
        })
        .select("id")
        .single();

      if (error) throw new Error(error.message);
      return { created: true, action_id: data.id };
    }),
};

export const upsertClient: AgentTool = {
  name: "create_or_update_client",
  description:
    "Add a new client, or update details on an existing one. Pass client_id to " +
    "update; leave it out to create. Never store an NRIC -- it will be stripped " +
    "automatically, and you should not ask for one.",
  input_schema: {
    type: "object",
    properties: {
      client_id: { type: "string", description: "Omit to create a new client." },
      full_name: { type: "string" },
      preferred_name: { type: "string" },
      dob: { type: "string", description: "YYYY-MM-DD." },
      gender: { type: "string", enum: ["M", "F", "other"] },
      marital_status: { type: "string", enum: ["single", "married", "divorced", "widowed"] },
      residency: { type: "string", enum: ["citizen", "pr", "ep_spass", "foreigner", "unknown"] },
      occupation: { type: "string" },
      employer: { type: "string" },
      annual_income: { type: "number" },
      phone: { type: "string" },
      email: { type: "string" },
      address_area: { type: "string" },
      status: {
        type: "string",
        enum: ["prospect", "active", "dormant", "lapsed", "referral_only", "former"],
      },
      profile_notes: {
        type: "string",
        description: "Standing context: hobbies, children's names, how they like to be contacted.",
      },
      review_interval_days: {
        type: "integer",
        description: "How often this client expects to hear from you. Default 180.",
      },
    },
    required: [],
    additionalProperties: false,
  },
  run: (input) =>
    safe(async () => {
      const { client_id, ...fields } = input;

      // Strip undefined so an update never blanks a field the model did not mention.
      const payload = Object.fromEntries(
        Object.entries(fields).filter(([, v]) => v !== undefined && v !== null),
      );

      if (client_id) {
        const { data, error } = await db()
          .from("clients")
          .update(payload)
          .eq("id", String(client_id))
          .select("id, full_name")
          .single();
        if (error) throw new Error(error.message);
        return { updated: true, client_id: data.id, full_name: data.full_name };
      }

      if (!payload.full_name) throw new Error("full_name is required to create a client.");

      const { data, error } = await db()
        .from("clients")
        .insert(payload)
        .select("id, full_name")
        .single();
      if (error) throw new Error(error.message);
      return { created: true, client_id: data.id, full_name: data.full_name };
    }),
};

export const addFamilyMember: AgentTool = {
  name: "add_family_member",
  description:
    "Record a spouse, child or dependant. Worth doing whenever one is " +
    "mentioned -- a child's birthday is a reason to call, and a new baby is " +
    "the most reliable trigger for a cover conversation there is.",
  input_schema: {
    type: "object",
    properties: {
      client_id: { type: "string" },
      name: { type: "string" },
      relationship: {
        type: "string",
        enum: ["spouse", "child", "parent", "sibling", "domestic_partner", "other"],
      },
      dob: { type: "string", description: "YYYY-MM-DD if known." },
      is_dependent: { type: "boolean" },
      is_insured: { type: "boolean" },
      notes: { type: "string" },
    },
    required: ["client_id", "relationship"],
    additionalProperties: false,
  },
  run: (input) =>
    safe(async () => {
      const { data, error } = await db()
        .from("family_members")
        .insert({
          client_id: String(input.client_id),
          name: input.name ? String(input.name) : null,
          relationship: String(input.relationship),
          dob: input.dob ? String(input.dob) : null,
          is_dependent: Boolean(input.is_dependent ?? false),
          is_insured: Boolean(input.is_insured ?? false),
          notes: input.notes ? String(input.notes) : null,
        })
        .select("id")
        .single();

      if (error) throw new Error(error.message);
      return { added: true, family_member_id: data.id };
    }),
};

export const createOpportunity: AgentTool = {
  name: "create_opportunity",
  description:
    "Record a live opportunity: a gap worth revisiting, a review that is due, " +
    "a referral offered. Use when the adviser describes something worth " +
    "following up on later rather than now.",
  input_schema: {
    type: "object",
    properties: {
      client_id: { type: "string" },
      kind: {
        type: "string",
        enum: [
          "protection_gap", "retirement_gap", "review_due", "upsell",
          "cross_sell", "referral", "claim_support", "lapse_risk",
        ],
      },
      headline: { type: "string" },
      rationale: { type: "string" },
      est_annual_premium: { type: "number" },
      next_step: { type: "string" },
      next_step_date: { type: "string", description: "YYYY-MM-DD." },
    },
    required: ["client_id", "kind", "headline"],
    additionalProperties: false,
  },
  run: (input) =>
    safe(async () => {
      const { data, error } = await db()
        .from("opportunities")
        .insert({
          client_id: String(input.client_id),
          kind: String(input.kind),
          headline: String(input.headline),
          rationale: input.rationale ? String(input.rationale) : null,
          est_annual_premium: input.est_annual_premium ?? null,
          next_step: input.next_step ? String(input.next_step) : null,
          next_step_date: input.next_step_date ? String(input.next_step_date) : null,
        })
        .select("id")
        .single();

      if (error) throw new Error(error.message);
      return { created: true, opportunity_id: data.id };
    }),
};

export const completeAction: AgentTool = {
  name: "complete_action_item",
  description: "Mark a promise as done, or drop it if it is no longer relevant.",
  input_schema: {
    type: "object",
    properties: {
      action_id: { type: "string" },
      outcome: { type: "string", enum: ["done", "dropped"] },
    },
    required: ["action_id"],
    additionalProperties: false,
  },
  run: (input) =>
    safe(async () => {
      const outcome = String(input.outcome ?? "done");
      const { error } = await db()
        .from("action_items")
        .update({
          status: outcome,
          completed_at: outcome === "done" ? new Date().toISOString() : null,
        })
        .eq("id", String(input.action_id));

      if (error) throw new Error(error.message);
      return { updated: true, status: outcome };
    }),
};

export const medisaveCheck: AgentTool = {
  name: "medisave_check",
  description:
    "Whether a policy line can be paid from MediSave, and up to what annual " +
    "limit. Reads the published CPF limits from the database rather than " +
    "relying on recall, because these are revised periodically and a stale " +
    "figure quoted to a client is a real problem. Use this for ANY question " +
    "about CPF, MediSave or how a Shield premium is funded.",
  input_schema: {
    type: "object",
    properties: {
      coverage_type: {
        type: "string",
        description: "The policy's coverage_type, e.g. 'Hospitalisation', 'Death'.",
      },
      is_rider: {
        type: "boolean",
        description:
          "True for an Integrated Shield rider. Riders are never MediSave-payable.",
      },
      age_next_birthday: { type: "integer" },
    },
    required: ["coverage_type", "is_rider", "age_next_birthday"],
    additionalProperties: false,
  },
  run: (input) =>
    safe(() =>
      rpc("medisave_payable", {
        policy_coverage_type: String(input.coverage_type),
        policy_is_rider: Boolean(input.is_rider),
        age_next_birthday: Number(input.age_next_birthday),
      })
    ),
};
