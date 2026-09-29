import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ScoutLLM,
  ScoutDecisionInput,
  ScoutSummaryInput,
  SummaryOutcome,
} from "./scout.js";
import { ScoutDecision } from "./types.js";

const run = promisify(execFile);

const DECISION_SYSTEM_PROMPT = `You are a scout agent for Chase, a Sui Move transaction analyzer. Your job is to decide what the scanner should do next based on results from the previous scan pass.

You will receive a JSON object with:
- mandate: the user's stated target, goal and checkpoint scope
- iteration: how many scan passes have completed
- previousFindings: findings from the last scan pass only (may be empty)
- currentFilter: the current package or substring filter
- coverage: what has actually been scanned so far
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
6. A filter change may only name a Sui object id (0x followed by 64 hex characters) or a short
   alphanumeric token. You may not redirect the scan to any other kind of value.

Respond with JSON only. No prose before or after. Schema:
{
  "action": "continue" | "widen" | "narrow" | "stop",
  "reason": "one-sentence explanation",
  "newFilter": "package/module string, only if action is widen or narrow"
}`;

const SUMMARY_SYSTEM_PROMPT = `You are a scout agent for Chase. Produce a brief report summarizing what was scanned and what was found.

You will receive a JSON object with the mandate, findings, decisions, coverage and budget usage.

The coverage field is the only trustworthy statement about what was actually scanned. State the
covered checkpoint range and the listed/analyzed transaction counts from it. If coverage says a
listing was truncated or the decision backend degraded, say so plainly - never describe an
incomplete scan as a clean one.

The report should be 3-5 sentences. Lead with the scope of the scan (target and covered checkpoint
range), then the findings count, then the most notable findings (if any), then a recommended next
step.

Be factual. Do not speculate about intent. If findings are all benign-pattern matches, say so. If
findings are novel, say so. Never claim to have found an exploit - Chase finds patterns, not exploits.

Respond with plain text. No JSON, no markdown.`;

interface LlmConfig {
  apiKey: string;
  endpoint: string;
  model: string;
}

const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 3000;
const ACTIONS = ["continue", "widen", "narrow", "stop"] as const;
const PACKAGE_ID = /^0x[0-9a-fA-F]{64}$/;
const TOKEN_FILTER = /^[A-Za-z0-9_:.,-]{1,80}$/;

export function loadConfig(): LlmConfig | null {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) return null;

  return {
    apiKey,
    endpoint: process.env.LLM_ENDPOINT ?? "https://openrouter.ai/api/v1/chat/completions",
    model: process.env.LLM_MODEL ?? "poolside/laguna-s-2.1:free",
  };
}

function curlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

interface LlmReply {
  content: string;
  tokens: number;
}

/**
 * Talks to the model through curl because Node's fetch stalls against some CDN edge routes.
 * The key is never placed on the argument vector, where any local process could read it from
 * /proc/<pid>/cmdline, so the whole request goes through a mode-0600 curl config file.
 */
async function callLlm(
  config: LlmConfig,
  system: string,
  user: string,
  maxTokens: number,
  forceJson = false
): Promise<LlmReply> {
  const body = JSON.stringify({
    model: config.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens: maxTokens,
    temperature: 0.1,
    ...(forceJson ? { response_format: { type: "json_object" } } : {}),
  });

  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "chase-llm-"));
  await fs.promises.chmod(dir, 0o700);
  const bodyPath = path.join(dir, "body.json");
  const confPath = path.join(dir, "curlrc");
  await fs.promises.writeFile(bodyPath, body, { mode: 0o600 });
  await fs.promises.writeFile(
    confPath,
    [
      `url = ${curlQuote(config.endpoint)}`,
      "request = POST",
      'header = "Content-Type: application/json"',
      `header = ${curlQuote(`Authorization: Bearer ${config.apiKey}`)}`,
      "silent",
      "show-error",
      "fail",
      "max-time = 60",
      `data-binary = ${curlQuote(`@${bodyPath}`)}`,
    ].join("\n"),
    { mode: 0o600 }
  );

  let lastError = "";
  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const { stdout } = await run("curl", ["--config", confPath], {
          encoding: "utf8",
          maxBuffer: 10 * 1024 * 1024,
        });

        if (!stdout || stdout.trim().length === 0) {
          throw new Error("empty response from curl");
        }

        const parsed = JSON.parse(stdout);

        if (parsed?.error) {
          throw new Error(
            `API error: ${parsed.error?.message ?? JSON.stringify(parsed.error).slice(0, 200)}`
          );
        }

        const choice = parsed?.choices?.[0];
        const message = choice?.message;

        let content: string | null = null;
        if (typeof message?.content === "string" && message.content.length > 0) {
          content = message.content;
        } else if (typeof message?.reasoning === "string" && message.reasoning.length > 0) {
          content = message.reasoning;
        } else if (typeof choice?.text === "string" && choice.text.length > 0) {
          content = choice.text;
        }

        if (typeof content !== "string") {
          throw new Error(`no usable content in response: ${JSON.stringify(parsed).slice(0, 200)}`);
        }

        const reported = parsed?.usage?.total_tokens;
        return { content, tokens: typeof reported === "number" ? reported : 0 };
      } catch (err: any) {
        lastError = err?.stderr?.toString?.().trim() || err?.message || String(err);
        if (attempt < MAX_ATTEMPTS - 1) {
          const delay = BASE_DELAY_MS * (attempt + 1);
          console.error(`[chase-scout] request failed (${lastError.slice(0, 160)}), retrying in ${delay}ms...`);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  throw new Error(lastError || "unknown error");
}

/**
 * Extracts the first JSON object from a reply. Reasoning models emit prose, fenced blocks and
 * nested braces around the answer, so this scans for a balanced object while honouring string
 * literals and escapes - a brace inside a string must not end the object.
 */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

/**
 * A malformed reply is reported as a degraded decision rather than a stop: the scan ends either
 * way, but the reader must be able to tell "the model chose to stop" from "the model never
 * answered". The filter is also constrained here, so a reply cannot retarget the scan to an
 * arbitrary value.
 */
export function parseDecision(text: string): ScoutDecision | null {
  if (!text) return null;

  const candidate = extractJsonObject(text);
  if (!candidate) return null;

  let obj: any;
  try {
    obj = JSON.parse(candidate);
  } catch {
    return null;
  }

  if (!obj || typeof obj !== "object") return null;
  if (typeof obj.action !== "string" || !ACTIONS.includes(obj.action as any)) return null;

  const reason =
    typeof obj.reason === "string" && obj.reason.trim().length > 0
      ? obj.reason.trim().slice(0, 500)
      : "no reason supplied";

  const decision: ScoutDecision = { action: obj.action, reason };

  if (typeof obj.newFilter === "string" && obj.newFilter.trim().length > 0) {
    const filter = obj.newFilter.trim();
    const safe = PACKAGE_ID.test(filter) || (TOKEN_FILTER.test(filter) && obj.action !== "stop");
    if (safe) decision.newFilter = filter;
    else decision.reason = `${reason} (ignored unusable newFilter)`;
  }

  return decision;
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
        reason: "no LLM configured (LLM_API_KEY is not set)",
        degraded: true,
      };
    }

    const userPrompt = JSON.stringify(
      {
        mandate: input.mandate,
        iteration: input.iteration,
        previousFindings: input.previousFindings.slice(0, 10),
        previousFindingsCount: input.previousFindings.length,
        currentFilter: input.currentFilter,
        coverage: input.coverage,
        remaining: input.remaining,
      },
      null,
      2
    );

    let reply: LlmReply;
    try {
      reply = await callLlm(this.config, DECISION_SYSTEM_PROMPT, userPrompt, 2048, true);
    } catch (err: any) {
      return {
        action: "stop",
        reason: `LLM unavailable: ${String(err?.message ?? err).slice(0, 200)}`,
        degraded: true,
        tokens: 0,
      };
    }

    const parsed = parseDecision(reply.content);
    if (!parsed) {
      return {
        action: "stop",
        reason: `LLM returned no parseable decision: ${reply.content.slice(0, 120)}`,
        degraded: true,
        tokens: reply.tokens,
      };
    }

    parsed.tokens = reply.tokens;
    return parsed;
  }

  async summarize(input: ScoutSummaryInput): Promise<SummaryOutcome> {
    if (!this.config) {
      return {
        text: "summary unavailable: no LLM configured (LLM_API_KEY is not set)",
        tokens: 0,
        degraded: true,
      };
    }

    const userPrompt = JSON.stringify(
      {
        mandate: input.mandate,
        findingsCount: input.findings.length,
        findings: input.findings.slice(0, 20),
        decisions: input.decisions,
        coverage: input.coverage,
        usage: input.usage,
      },
      null,
      2
    );

    try {
      const reply = await callLlm(this.config, SUMMARY_SYSTEM_PROMPT, userPrompt, 1024);
      return {
        text: reply.content.trim() || "(empty summary)",
        tokens: reply.tokens,
        degraded: false,
      };
    } catch (err: any) {
      return {
        text: `summary unavailable: LLM unavailable (${String(err?.message ?? err).slice(0, 160)})`,
        tokens: 0,
        degraded: true,
      };
    }
  }
}
