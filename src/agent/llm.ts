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
import {
  InvestigationInput,
  InvestigationOutcome,
} from "./investigator.js";
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

const INVESTIGATION_SYSTEM_PROMPT = `You are the investigator for Chase, a Sui Move transaction analyzer. A transaction
was escalated by triage; you are the second look, not the first score.

You receive JSON: the digest, triage's tier/score/nextAction, the violations that produced them, and
evidence read from the transaction itself: the PTB commands in order, the packages called, the names
each high-severity signal matched on ("signals"), coin movements, object transfers, and events.

Say what the transaction appears to be doing, and whether the pattern that escalated it survives
contact with that evidence.

Verdicts:
- "benign": the evidence shows an ordinary shape, which most escalations do. A price-feed
  "update_price"/"refresh" call followed later by a "swap"/"withdraw" is the documented
  false-positive shape of the oracle heuristic: that detector matches function *names*, so a protocol
  refreshing its own feed before a user withdraws fires it. Say so plainly when that is what you see.
- "suspicious": the evidence shows a structure that should not be reachable: an oracle-flavoured call
  immediately followed in the same PTB by a trade against that value, value leaving to the sender or
  to a freshly created object, an owner-cap moved away from its signer while still being used. Name
  the commands that make it so, and keep the claim to what the commands are, not what they write.
- "needs-review": the evidence cannot answer the question. Unresolved signatures, an unreadable
  trace, a name you do not recognise doing something financial, or a verdict that turns on who
  controls a value the evidence cannot show. Do not guess.

Rules:
1. Reason only from the evidence given. Never invent a package id, module, function, address or
   amount that is not in it.
2. Name what you rely on: quote the command or signal your verdict rests on.
3. The evidence has no function signatures and no call arguments. So never state who controls a
   value, or what a function writes, as if you had read it. If that is what settles the question,
   answer "needs-review" and name the function a person must read.
4. Chase finds patterns, not exploits. Do not describe anything as an exploit, a theft or a confirmed
   vulnerability, and do not assign a severity.
5. "hypothesis" is a short handle for the shape you saw, e.g. "feed refresh before withdrawal".
6. "reasoning" is 2-4 sentences: what the transaction does, then why the escalated signal does or
   does not survive it.

Respond with JSON only. No prose before or after. Schema:
{
  "verdict": "benign" | "suspicious" | "needs-review",
  "hypothesis": "short phrase",
  "reasoning": "2-4 sentences"
}`;

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

const VERDICTS = ["benign", "suspicious", "needs-review"] as const;

/**
 * A reply that cannot be parsed is not a verdict. Returning null makes the caller say the reading
 * failed, rather than defaulting to "suspicious" (which would cry wolf) or "benign" (which would
 * bury a finding).
 */
export function parseInvestigation(text: string): InvestigationOutcome | null {
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
  if (typeof obj.verdict !== "string" || !VERDICTS.includes(obj.verdict as any)) return null;

  const hypothesis =
    typeof obj.hypothesis === "string" && obj.hypothesis.trim()
      ? obj.hypothesis.trim().slice(0, 120)
      : "unlabelled";
  const reasoning =
    typeof obj.reasoning === "string" && obj.reasoning.trim()
      ? obj.reasoning.trim().slice(0, 1200)
      : "the model returned a verdict without a reason";

  return { verdict: obj.verdict, hypothesis, reasoning, source: "model" };
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

  async investigate(input: InvestigationInput): Promise<InvestigationOutcome> {
    if (!this.config) {
      return {
        verdict: "needs-review",
        hypothesis: "not read",
        reasoning: "no LLM configured (LLM_API_KEY is not set), so no model read this transaction",
        source: "fallback",
        degraded: true,
        tokens: 0,
      };
    }

    const userPrompt = JSON.stringify(
      {
        digest: input.digest,
        network: input.network,
        tier: input.tier,
        score: input.score,
        nextAction: input.action,
        violations: input.violations.map((v) => ({
          type: v.type,
          severity: v.severity,
          message: v.message,
        })),
        evidence: input.evidence,
      },
      null,
      2
    );

    try {
      const reply = await callLlm(this.config, INVESTIGATION_SYSTEM_PROMPT, userPrompt, 1200, true);
      const parsed = parseInvestigation(reply.content);
      if (!parsed) {
        return {
          verdict: "needs-review",
          hypothesis: "unread",
          reasoning: `model gave no parseable reading: ${reply.content.slice(0, 160)}`,
          source: "fallback",
          degraded: true,
          tokens: reply.tokens,
        };
      }
      parsed.tokens = reply.tokens;
      parsed.model = this.config.model;
      return parsed;
    } catch (err: any) {
      return {
        verdict: "needs-review",
        hypothesis: "unread",
        reasoning: `no model reading: ${String(err?.message ?? err).slice(0, 160)}`,
        source: "fallback",
        degraded: true,
        tokens: 0,
      };
    }
  }
}
