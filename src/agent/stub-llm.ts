import { ScoutLLM, ScoutDecisionInput, ScoutSummaryInput, SummaryOutcome } from "./scout.js";
import { InvestigationInput, InvestigationOutcome } from "./investigator.js";
import { ScoutDecision } from "./types.js";
import { coverageCaveat } from "./report-md.js";

export class StubLLM implements ScoutLLM {
  async decide(input: ScoutDecisionInput): Promise<ScoutDecision> {
    if (input.iteration >= 3) {
      return { action: "stop", reason: "stub: max iterations reached" };
    }
    if (input.previousFindings.length > 20) {
      return {
        action: "narrow",
        reason: "stub: too many findings, narrowing filter",
        newFilter: input.currentFilter,
      };
    }
    if (input.previousFindings.length === 0 && input.iteration >= 2) {
      return {
        action: "stop",
        reason: "stub: no findings in two iterations",
      };
    }
    return { action: "continue", reason: "stub: keep scanning" };
  }

  async summarize(input: ScoutSummaryInput): Promise<SummaryOutcome> {
    const total = input.findings.length;
    const byType: Record<string, number> = {};
    for (const f of input.findings) {
      for (const v of f.violations) {
        byType[v.type] = (byType[v.type] ?? 0) + 1;
      }
    }
    const c = input.coverage;
    const lines = [
      `Scanned for target ${input.mandate.target}`,
      `Goal: ${input.mandate.goal}`,
      `Coverage: ${coverageCaveat(c)}; ${c.txsListed} listed, ${c.txsAnalyzed} analyzed`,
      `Total findings: ${total}`,
      `Breakdown: ${JSON.stringify(byType)}`,
      `Decisions: ${input.decisions.map((d) => d.action).join(" -> ")}`,
    ];
    return { text: lines.join("\n"), tokens: 0 };
  }

  async investigate(input: InvestigationInput): Promise<InvestigationOutcome> {
    return {
      verdict: "suspicious",
      hypothesis: "stub: fixed response",
      reasoning: `stub reading for ${input.digest.slice(0, 12)}… — ${input.evidence.commandCount} command(s), ${input.violations.length} violation(s), never a judgement`,
      source: "stub",
      tokens: 0,
    };
  }
}
