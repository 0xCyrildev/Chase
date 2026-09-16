import { ScoutLLM, ScoutDecisionInput, ScoutSummaryInput } from "./scout.js";
import { ScoutDecision } from "./types.js";

/**
 * Deterministic replacement for the LLM decision layer. Implements the same
 * rules documented in the LLM system prompt, without any network dependency.
 */
export class RuleBasedLLM implements ScoutLLM {
  async decide(input: ScoutDecisionInput): Promise<ScoutDecision> {
    const { iteration, previousFindings, remaining } = input;

    if (remaining.rpc < 5) {
      return { action: "stop", reason: `rpc budget low (${remaining.rpc} remaining)` };
    }

    if (remaining.llm < 1) {
      return { action: "stop", reason: `llm budget low (${remaining.llm} remaining)` };
    }

    if (remaining.ms < 10000) {
      return { action: "stop", reason: `wall time low (${remaining.ms}ms remaining)` };
    }

    if (iteration >= 5) {
      return { action: "stop", reason: "iteration limit reached" };
    }

    if (previousFindings.length > 20) {
      return {
        action: "narrow",
        reason: `too many findings in one pass (${previousFindings.length})`,
      };
    }

    if (previousFindings.length === 0 && iteration >= 3) {
      return {
        action: "stop",
        reason: "no findings in three consecutive iterations",
      };
    }

    return { action: "continue", reason: "scanning with current filter" };
  }

  async summarize(input: ScoutSummaryInput): Promise<string> {
    const byType: Record<string, number> = {};
    for (const f of input.findings) {
      for (const v of f.violations) {
        byType[v.type] = (byType[v.type] ?? 0) + 1;
      }
    }

    const typeBreakdown =
      Object.keys(byType).length > 0
        ? Object.entries(byType)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ")
        : "none";

    const decisionChain = input.decisions.map((d) => d.action).join(" -> ");

    return [
      `Scanned ${input.mandate.target} over a ${input.mandate.windowSeconds}s window`,
      `for goal: "${input.mandate.goal}".`,
      `Findings: ${input.findings.length} (${typeBreakdown}).`,
      `Decision chain: ${decisionChain}.`,
      `Budget used: ${input.usage.rpcCalls} RPC, ${input.usage.llmCalls} LLM calls, ${input.usage.elapsedMs}ms.`,
      input.findings.length === 0
        ? "No violations detected. Recommend widening the window or lowering the filter specificity."
        : "Findings present. Recommend triage on the returned digests.",
    ].join(" ");
  }
}
