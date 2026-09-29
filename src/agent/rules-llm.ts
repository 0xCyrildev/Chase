import { ScoutLLM, ScoutDecisionInput, ScoutSummaryInput, SummaryOutcome } from "./scout.js";
import { InvestigationInput, InvestigationOutcome } from "./investigator.js";
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
          : "Findings present, triaged and escalated: see the tiers on each digest.",
      ]
        .filter((line): line is string => line !== null)
        .join(" "),
      tokens: 0,
    };
  }

  /**
   * A deterministic reading. It cannot judge a transaction, so it does not pretend to: it says which
   * of the fired signals rest on a function name and what a human would have to read to settle it.
   * The counts and matched names are in the evidence line the report prints alongside this, so they
   * are not restated here. `source: "rules"` keeps it distinct from a model's answer.
   */
  async investigate(input: InvestigationInput): Promise<InvestigationOutcome> {
    const e = input.evidence;
    const unreadable = e.notes.find((n) => n.startsWith("trace unreadable"));
    if (unreadable) {
      return {
        verdict: "needs-review",
        hypothesis: "unreadable trace",
        reasoning: `${unreadable}; tier ${input.tier ?? "?"} stands on ${input.violations.length} violation(s) and nothing else could be verified.`,
        source: "rules",
        tokens: 0,
      };
    }

    if (input.tier === "NOISE" || input.tier === "P3") {
      return {
        verdict: "benign",
        hypothesis: "low-priority pattern",
        reasoning: `Triage scored this ${input.score ?? "?"}/100 (${input.tier}), at or below the noise line; signals: ${signalTypes(e.signals)}.`,
        source: "rules",
        tokens: 0,
      };
    }

    const structural = e.signals.filter((s) => !NAME_MATCHED.has(s.type));
    const nameMatched = e.signals.filter((s) => NAME_MATCHED.has(s.type));

    if (structural.length > 0) {
      return {
        verdict: "suspicious",
        hypothesis: structural.map((s) => s.type).join(", "),
        reasoning:
          `Signals that do not rest on a function name: ${signalTypes(structural)}. ` +
          `Name-matched alongside them: ${nameMatched.length ? signalTypes(nameMatched) : "none"}. ` +
          `Check the evidence line against the transaction before acting on this.`,
        source: "rules",
        tokens: 0,
      };
    }

    return {
      verdict: "needs-review",
      hypothesis: "name match only",
      reasoning:
        `Every high-severity signal here fired on a function name: ${signalTypes(nameMatched)}. ` +
        `A name match is not a state change — read the left-hand function of each pair to check whether it ` +
        `writes a value the right-hand call consumes. Nothing here is evidence either way.`,
      source: "rules",
      tokens: 0,
    };
  }
}

/**
 * The invariants that key off function names. They are the documented false-positive surface, so a
 * reading made of nothing but these cannot be called suspicious on structure alone.
 */
const NAME_MATCHED = new Set([
  "ORACLE_MANIPULATION_SUSPECTED",
  "REENTRANCY_PATTERN",
  "REPEATED_MODULE_CALLS",
]);

function signalTypes(
  signals: InvestigationInput["evidence"]["signals"]
): string {
  if (signals.length === 0) return "none";
  return signals
    .map((s) => `${s.type}${s.count > 1 ? `×${s.count}` : ""}`)
    .join(", ");
}
