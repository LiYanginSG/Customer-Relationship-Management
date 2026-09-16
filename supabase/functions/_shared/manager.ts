/**
 * manager.ts -- the only one you talk to.
 *
 * The manager holds no lookup tools of their own. They hold one delegate tool
 * per desk, plus the write tools for filing what you tell them. When you ask a
 * question, the manager works out which desk owns it, asks them, and answers
 * you in one voice.
 *
 * That indirection is the point: you describe what you want in your own words
 * and never have to remember which system holds which fact.
 */

import { runAgent, type AgentTool, BudgetExceededError } from "./claude.ts";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { sgNow } from "./dates.ts";
import { DESKS, askDesk } from "./staff/index.ts";
import * as T from "./staff/tools.ts";

// ---------------------------------------------------------------------------
// Delegation: one tool per desk
// ---------------------------------------------------------------------------

const delegateTools: AgentTool[] = DESKS.map((desk) => ({
  name: `ask_${desk.key}`,
  description:
    `Put a question to the ${desk.title} desk.\n\n${desk.remit}\n\n` +
    "Ask in a full sentence, including any client name or timeframe you " +
    "already know. They cannot see your conversation with the adviser -- only " +
    "what you send them.",
  input_schema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description:
          "A complete, self-contained question. Include names and dates you " +
          "already know rather than making them look it up again.",
      },
    },
    required: ["question"],
    additionalProperties: false,
  },
  run: async (input) => await askDesk(desk.key, String(input.question)),
}));

/**
 * The write tools sit with the manager rather than the desks. Only the person
 * you are actually talking to can change your records, which makes the blast
 * radius of a confused lookup agent exactly zero.
 */
const writeTools: AgentTool[] = [
  T.findClient,
  T.logInteraction,
  T.createAction,
  T.completeAction,
  T.upsertClient,
  T.addFamilyMember,
  T.createOpportunity,
];

const managerTools: AgentTool[] = [...delegateTools, ...writeTools];

// ---------------------------------------------------------------------------
// The manager's brief
// ---------------------------------------------------------------------------

function managerBrief(): string {
  const roster = DESKS.map((d) => `  - ask_${d.key}: ${d.title}`).join("\n");

  return `You are the practice manager for a licensed financial services
consultant in Singapore. They are your only contact. They reach you by Telegram,
usually on the move -- between appointments, in a lift, driving home from a
client's flat.

You run five desks. You are the only one who talks to the adviser:

${roster}

HOW YOU WORK

Delegate rather than guess. If a question touches birthdays, policies, who to
see, past conversations or product wording, ask the desk that owns it. Ask
several at once when a question spans desks -- "brief me on Sarah before my
2pm" wants the relationship desk and the policy desk in parallel, not one after
the other.

Answer in one voice. The adviser hired a manager, not a switchboard. Never say
"the policy desk reports that". Just tell them the answer.

FILING WHAT THEY TELL YOU

Half of what arrives is not a question, it is a debrief. "Just saw Mr Tan, wife
expecting in March, worried about his SA top-up." When that happens:

  1. find_client to identify who they mean. If two people match, ask which.
  2. log_interaction with a summary in their own words, not your tidier version.
  3. add_family_member for anyone new who was mentioned.
  4. create_action_item for anything they implied they would do.
  5. create_opportunity for something worth revisiting later rather than now.

Then confirm briefly what you filed. One line. They are driving.

If you genuinely cannot tell who they mean, ask. One short question, then file
it once they answer. Never invent a client to attach a note to.

HOW YOU WRITE

This is Telegram, not a report. Short paragraphs, no headers, no bullet lists
unless you are genuinely listing things. Two or three sentences is usually
right. A morning briefing may run longer.

Write the way a good colleague talks: direct, warm, no filler. Never open with
"Certainly" or "I'd be happy to". Just answer.

Use their vocabulary. Shield plan, CI, ILP, SA top-up, AV, MDRT, orphan case.
Do not explain terms they use professionally every day.

Singapore formatting: dollar amounts as $1,250; dates as 18 Sep; day names for
anything inside a fortnight.

WHERE YOUR AUTHORITY ENDS

You are back-office support to a licensed representative. You never recommend a
specific product, never assess suitability, never tell them what a client should
buy. You surface facts, gaps and timing. They advise -- that is what their
licence is for and what their compliance team will hold them to.

Never state a policy number, premium, sum assured or product term you have not
had back from a desk. If you do not have it, say so. A number that turns out to
be wrong in front of a client is far more costly than an admission that you need
to check.

NRIC and FIN numbers are deliberately not stored anywhere in this system. Never
ask for one, never repeat one.

Today is ${sgNow()} in Singapore.`;
}

// ---------------------------------------------------------------------------
// Conversation memory
// ---------------------------------------------------------------------------

const HISTORY_TURNS = 12;

async function loadHistory(chatId: number): Promise<
  Array<{ role: "user" | "assistant"; content: string }>
> {
  const { data, error } = await db()
    .from("conversation_turns")
    .select("role, content")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(HISTORY_TURNS);

  if (error) {
    console.error("could not load history", error.message);
    return [];   // a forgetful manager still beats a broken one
  }

  return (data ?? [])
    .reverse()
    .map((r) => ({ role: r.role as "user" | "assistant", content: r.content }));
}

async function saveTurn(
  chatId: number,
  role: "user" | "assistant",
  content: string,
): Promise<void> {
  const { error } = await db()
    .from("conversation_turns")
    .insert({ chat_id: chatId, role, content });
  if (error) console.error("could not save turn", error.message);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface ManagerReply {
  text: string;
  costUsd: number;
  desksConsulted: string[];
}

/** Handle one message from the adviser and produce the manager's reply. */
export async function handleMessage(
  chatId: number,
  message: string,
): Promise<ManagerReply> {
  const history = await loadHistory(chatId);

  try {
    const result = await runAgent({
      agent: "manager",
      system: managerBrief(),
      messages: [...history, { role: "user", content: message }],
      tools: managerTools,
      model: config.managerModel,
      effort: "medium",
      maxTokens: 8000,
      maxIterations: 10,
    });

    // Save both sides together, so history never ends on a dangling question.
    await saveTurn(chatId, "user", message);
    await saveTurn(chatId, "assistant", result.text);

    return {
      text: result.text,
      costUsd: result.costUsd,
      desksConsulted: [...new Set(
        result.toolsUsed.filter((t) => t.startsWith("ask_")).map((t) => t.slice(4)),
      )],
    };
  } catch (e) {
    if (e instanceof BudgetExceededError) {
      return {
        text:
          `I've hit today's spending limit (US$${e.cap.toFixed(2)}), so I've stopped ` +
          `to avoid surprising you.\n\nYour scheduled alerts still work — those cost ` +
          `nothing. The limit resets at midnight, and you can raise it in Supabase ` +
          `under <code>app_settings</code>.`,
        costUsd: 0,
        desksConsulted: [],
      };
    }
    throw e;
  }
}
