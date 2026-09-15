import { execFileSync } from "node:child_process";
import { ScoutLLM, ScoutDecisionInput, ScoutSummaryInput } from "./scout.js";
import { ScoutDecision } from "./types.js";

const DECISION_SYSTEM_PROMPT = `You are a scout agent for Chase, a Sui Move transaction analyzer. Your job is to decide what the scanner should do next based on results from the previous scan pass.

You will receive a JSON object with:
- mandate: the user's stated target, goal, and window
- iteration: how many scan passes have completed
- previousFindings: findings from the last scan pass (may be empty)
- currentFilter: the current package/module filter
- remaining: budget remaining (rpc calls, llm calls, tokens, milliseconds)

Decide one of four actions:

- "continue": keep scanning with the current filter
- "widen": broaden the filter (remove constraints, accept more matches)
- "narrow": tighten the filter (add constraints, accept fewer matches)
- "stop": end the scan and produce a report

Rules:

1. If previousFindings is empty for two consecutive iterations, "stop".
2. If previousFindings has more than 20 entries in one pass, the filter is too broad - "narrow".
3. If remaining.rpc is less than 20, "stop" to preserve budget.
4. If iteration is 5 or more, "stop" and report what you have.
5. Otherwise, "continue" unless there's a clear reason to change the filter.

Respond with JSON only. Schema:
{
  "action": "continue" | "widen" | "narrow" | "stop",
  "reason": "one-sentence explanation",
  "newFilter": "package/module string, only if action is widen or narrow"
}`;

const SUMMARY_SYSTEM_PROMPT = `You are a scout agent for Chase. Produce a brief report summarizing what was scanned and what was found.

You will receive a JSON object with the mandate, findings, decisions, and budget usage.

The report should be 3-5 sentences. Lead with the scope of the scan (target, window), then the findings count, then the most notable findings (if any), then a recommended next step.

Be factual. Do not speculate about intent. If findings are all benign-pattern matches, say so. If findings are novel, say so. Never claim to have found an exploit - Chase finds patterns, not exploits.

Respond with plain text. No JSON, no markdown.`;

interface LlmConfig {
  apiKey: string;
  endpoint: string;
  model: string;
}

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 3000;

function loadConfig(): LlmConfig | null {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;

  return {
    apiKey,
    endpoint: process.env.DEEPSEEK_ENDPOINT ?? "https://openrouter.ai/api/v1/chat/completions",
    model: process.env.DEEPSEEK_MODEL ?? "deepseek/deepseek-r1:free",
  };
}

async function callLlm(
  config: LlmConfig,
  system: string,
  user: string,
  maxTokens: number
): Promise<string> {
  const body = JSON.stringify({
    model: config.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens: maxTokens,
    temperature: 0.1,
  });

  const args = [
    "-s",
    "-X", "POST",
    config.endpoint,
    "-H", "Content-Type: application/json",
    "-H", `Authorization: Bearer ${config.apiKey}`,
    "-d", body,
    "--max-time", "60",
  ];

  let lastError = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const out = execFileSync("curl", args, {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      });

      if (!out || out.trim().length === 0) {
        throw new Error("empty response from curl");
      }

      const parsed = JSON.parse(out);

      if (parsed?.error) {
        throw new Error(`API error: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
      }

      const content = parsed?.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new Error(`unexpected response shape: ${JSON.stringify(parsed).slice(0, 200)}`);
      }

      return content;
    } catch (err: any) {
      lastError = err?.message ?? String(err);
      if (attempt < MAX_ATTEMPTS - 1) {
        const delay = BASE_DELAY_MS * (attempt + 1);
        console.error(`[chase-scout] request failed (${lastError}), retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
    }
  }

  throw new Error(lastError || "unknown error");
}

export class RealLLM implements ScoutLLM {
  private config: LlmConfig | null;

  constructor() {
    this.config = loadConfig();
  }

  async decide(input: ScoutDecisionInput): Promise<ScoutDecision> {
    if (!this.config) {
      return {
        action: "stop",
        reason: "no LLM configured (DEEPSEEK_API_KEY not set)",
      };
    }

    const userPrompt = JSON.stringify(
      {
        mandate: input.mandate,
        iteration: input.iteration,
        previousFindings: input.previousFindings.slice(0, 10),
        previousFindingsCount: input.previousFindings.length,
        currentFilter: input.currentFilter,
        remaining: input.remaining,
      },
      null,
      2
    );

    try {
      const content = await callLlm(this.config, DECISION_SYSTEM_PROMPT, userPrompt, 256);
      const parsed = parseDecision(content);

      if (!parsed) {
        return {
          action: "stop",
          reason: `LLM returned invalid JSON: ${content.slice(0, 100)}`,
        };
      }

      return parsed;
    } catch (err: any) {
      return {
        action: "stop",
        reason: `LLM exception: ${err?.message ?? err}`,
      };
    }
  }

  async summarize(input: ScoutSummaryInput): Promise<string> {
    if (!this.config) {
      return "no LLM configured, summary unavailable";
    }

    const userPrompt = JSON.stringify(
      {
        mandate: input.mandate,
        findingsCount: input.findings.length,
        findings: input.findings.slice(0, 20),
        decisions: input.decisions,
        usage: input.usage,
      },
      null,
      2
    );

    try {
      const content = await callLlm(this.config, SUMMARY_SYSTEM_PROMPT, userPrompt, 512);
      return content || "(empty summary)";
    } catch (err: any) {
      return `LLM exception: ${err?.message ?? err}`;
    }
  }
}

function parseDecision(text: string): ScoutDecision | null {
  try {
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const obj = JSON.parse(cleaned);
    if (
      typeof obj.action !== "string" ||
      !["continue", "widen", "narrow", "stop"].includes(obj.action)
    ) {
      return null;
    }
    return obj as ScoutDecision;
  } catch {
    return null;
  }
}
