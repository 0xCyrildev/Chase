import { ScoutLLM, ScoutDecisionInput, ScoutSummaryInput, SummaryOutcome } from "./scout.js";
import { ScoutDecision } from "./types.js";
import { coverageCaveat, coverageSpan } from "./report-md.js";

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

  async summarize(input: ScoutSummaryInput): Promise<SummaryOutcome> {
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

    const c = input.coverage;
    const span = coverageSpan(c);
    const covered =
      c.startCheckpoint && c.endCheckpoint
        ? `seq ${c.startCheckpoint}..${c.endCheckpoint}`
        : "no range";

    const degraded = input.decisions.filter((d) => d.degraded).length;

    return {
      text: [
        `Scanned ${input.mandate.target} over ${c.passes} passes spanning seq ${covered.replace("seq ", "")} (${span ?? 0} checkpoints wide;`,
        `${c.txsListed} txs listed, ${c.txsTargetMissed} did not call the target, ${c.txsAnalyzed} analyzed)`,
        `for goal: "${input.mandate.goal}".`,
        `Coverage: ${coverageCaveat(c)}.`,
        degraded > 0
          ? `${degraded} of ${input.decisions.length} decisions came from a degraded backend, not from a model.`
          : null,
        `Findings: ${input.findings.length} (${typeBreakdown}).`,
        `Decision chain: ${decisionChain}.`,
        `Budget used: ${input.usage.rpcCalls} RPC, ${input.usage.llmCalls} LLM calls, ${input.usage.llmTokens} tokens, ${input.usage.elapsedMs}ms.`,
        input.findings.length === 0
          ? c.passes === 0
            ? "NOTHING SCANNED — no pass ran (dry-run, or the budget stopped first); this is not a result about the target."
            : c.txsListed === 0
              ? "This was an EMPTY SCAN, not a clean one: the range listed no transactions at all."
              : c.txsAnalyzed === 0
                ? `EMPTY AGAINST THE TARGET, not a clean scan: ${c.txsListed} transactions in range, none called ${input.mandate.target}.`
                : c.txsTargetMissed > 0
                  ? `No violations in the ${c.txsAnalyzed} transaction(s) that reached ${input.mandate.target}; ${c.txsTargetMissed} inspected did not involve it.`
                  : "No violations detected within the covered range."
          : "Findings present. Recommend triage on the returned digests.",
      ]
        .filter((line): line is string => line !== null)
        .join(" "),
      tokens: 0,
    };
  }
}
