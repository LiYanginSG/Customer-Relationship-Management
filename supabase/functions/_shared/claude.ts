/**
 * claude.ts -- the wrapper every agent calls through.
 *
 * Three jobs, in order of importance:
 *   1. Refuse to spend money you have not agreed to spend.
 *   2. Never let an NRIC reach the model.
 *   3. Run the tool loop.
 *
 * On the loop: this uses a manual agentic loop rather than the SDK's tool
 * runner. The runner is still beta, and this service runs unattended at 7am
 * with nobody watching -- a stable dependency is worth more here than the few
 * lines the runner would save. The loop also needs to re-check the budget
 * between iterations, which is cleaner to express directly.
 */

import Anthropic from "npm:@anthropic-ai/sdk@0.124.0";
import { config, aiEnabled } from "./config.ts";
import { db, rpc } from "./db.ts";
import { scrubNric } from "./nric.ts";

// ---------------------------------------------------------------------------
// Cost model. Dollars per million tokens, from Anthropic's published pricing.
// Used only to enforce your daily cap -- the real bill is Anthropic's.
// Cache reads are billed at roughly a tenth of the input rate.
// ---------------------------------------------------------------------------

const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5.0, output: 25.0 },
  "claude-sonnet-5": { input: 2.0, output: 10.0 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
};

function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
): number {
  const rate = PRICING[model] ?? PRICING["claude-opus-5"];
  return (
    (inputTokens / 1_000_000) * rate.input +
    (outputTokens / 1_000_000) * rate.output +
    (cacheReadTokens / 1_000_000) * rate.input * 0.1
  );
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export class BudgetExceededError extends Error {
  constructor(public readonly spentToday: number, public readonly cap: number) {
    super(
      `Daily AI budget reached: US$${spentToday.toFixed(3)} of US$${cap.toFixed(2)}.`,
    );
    this.name = "BudgetExceededError";
  }
}

/** The cap from the database if set, otherwise the one from the environment. */
async function currentCap(): Promise<number> {
  const { data } = await db()
    .from("app_settings")
    .select("daily_spend_cap_usd")
    .eq("id", 1)
    .maybeSingle();

  const fromDb = data?.daily_spend_cap_usd;
  return fromDb != null ? Number(fromDb) : config.dailyCapUsd;
}

export async function spendToday(): Promise<number> {
  try {
    return Number(await rpc<number>("ai_spend_today"));
  } catch (e) {
    // If the ledger is unreadable, assume the worst and stop. Failing closed on
    // a spending control is the only defensible direction.
    console.error("could not read today's spend", e);
    throw new Error("Spend ledger unavailable; refusing to call the model.");
  }
}

async function assertWithinBudget(): Promise<void> {
  const [spent, cap] = await Promise.all([spendToday(), currentCap()]);
  if (spent >= cap) throw new BudgetExceededError(spent, cap);
}

async function recordUsage(
  agent: string,
  model: string,
  usage: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  },
): Promise<void> {
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;

  try {
    await db().from("ai_usage").insert({
      agent,
      model,
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: cacheRead,
      est_cost_usd: estimateCost(model, input, output, cacheRead),
    });
  } catch (e) {
    console.error("failed to record AI usage", e);  // never fail a reply over bookkeeping
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

let anthropic: Anthropic | null = null;

function client(): Anthropic {
  if (!aiEnabled()) {
    throw new Error(
      "No ANTHROPIC_API_KEY is set, so the manager and staff are not awake. " +
        "Scheduled alerts still work.",
    );
  }
  if (!anthropic) anthropic = new Anthropic({ apiKey: config.anthropicKey });
  return anthropic;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface AgentTool {
  name: string;
  description: string;
  // deno-lint-ignore no-explicit-any
  input_schema: any;
  run: (input: Record<string, unknown>) => Promise<unknown>;
}

export interface RunOptions {
  /** Label for the usage ledger, e.g. "manager" or "staff:policy". */
  agent: string;
  system: string;
  messages: Anthropic.MessageParam[];
  tools?: AgentTool[];
  model?: string;
  maxTokens?: number;
  /** low for focused staff lookups, medium for the manager's judgement calls. */
  effort?: "low" | "medium" | "high";
  /** Stops a misbehaving loop from burning the day's budget in one turn. */
  maxIterations?: number;
}

export interface RunResult {
  text: string;
  costUsd: number;
  iterations: number;
  toolsUsed: string[];
}

/**
 * Run an agent to completion: call the model, execute any tools it asks for,
 * feed the results back, repeat until it answers.
 */
export async function runAgent(opts: RunOptions): Promise<RunResult> {
  await assertWithinBudget();

  const model = opts.model ?? config.managerModel;
  const maxIterations = opts.maxIterations ?? 8;
  const tools = opts.tools ?? [];
  const toolsUsed: string[] = [];

  const toolDefs = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));

  const byName = new Map(tools.map((t) => [t.name, t]));
  const messages: Anthropic.MessageParam[] = [...opts.messages];

  let costUsd = 0;
  let iterations = 0;
  let finalText = "";

  while (iterations < maxIterations) {
    iterations += 1;

    const response = await client().messages.create({
      model,
      max_tokens: opts.maxTokens ?? 8000,
      // The system prompt is identical on every call, so caching it turns the
      // largest stable chunk of each request into a tenth-price cache read.
      system: [{
        type: "text",
        text: opts.system,
        cache_control: { type: "ephemeral" },
      }],
      output_config: { effort: opts.effort ?? "medium" },
      ...(toolDefs.length > 0 ? { tools: toolDefs } : {}),
      messages,
    });

    costUsd += estimateCost(
      model,
      response.usage.input_tokens ?? 0,
      response.usage.output_tokens ?? 0,
      response.usage.cache_read_input_tokens ?? 0,
    );
    await recordUsage(opts.agent, model, response.usage);

    // Collect any text the model produced this turn.
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (text) finalText = text;

    if (response.stop_reason === "refusal") {
      return {
        text: "I could not answer that one. Try rephrasing it?",
        costUsd,
        iterations,
        toolsUsed,
      };
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (toolUses.length === 0) break;

    messages.push({ role: "assistant", content: response.content });

    // Run the requested tools in parallel, then return every result in one
    // user message. Splitting them across messages teaches the model to stop
    // asking for parallel work.
    const results = await Promise.all(
      toolUses.map(async (use): Promise<Anthropic.ToolResultBlockParam> => {
        const tool = byName.get(use.name);
        if (!tool) {
          return {
            type: "tool_result",
            tool_use_id: use.id,
            content: `No such tool: ${use.name}`,
            is_error: true,
          };
        }
        toolsUsed.push(use.name);
        try {
          const out = await tool.run(use.input as Record<string, unknown>);
          return {
            type: "tool_result",
            tool_use_id: use.id,
            content: scrubNric(
              typeof out === "string" ? out : JSON.stringify(out, null, 1),
            ),
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`tool ${use.name} failed:`, msg);
          return {
            type: "tool_result",
            tool_use_id: use.id,
            content: `That lookup failed: ${msg}`,
            is_error: true,
          };
        }
      }),
    );

    messages.push({ role: "user", content: results });

    // Re-check between iterations. A runaway loop is exactly the scenario the
    // cap exists for, and waiting until the next turn is too late.
    await assertWithinBudget();
  }

  if (!finalText) {
    finalText =
      "I looked, but could not put together a clear answer. Ask me a narrower question?";
  }

  return { text: finalText, costUsd, iterations, toolsUsed };
}
