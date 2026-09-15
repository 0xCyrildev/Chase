import { ScoutLLM, ScoutDecisionInput, ScoutSummaryInput } from "./scout.js";
import { ScoutDecision } from "./types.js";

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

  async summarize(input: ScoutSummaryInput): Promise<string> {
    const total = input.findings.length;
    const byType: Record<string, number> = {};
    for (const f of input.findings) {
      for (const v of f.violations) {
        byType[v.type] = (byType[v.type] ?? 0) + 1;
      }
    }
    const lines = [
      `Scanned for target ${input.mandate.target}`,
      `Goal: ${input.mandate.goal}`,
      `Total findings: ${total}`,
      `Breakdown: ${JSON.stringify(byType)}`,
      `Decisions: ${input.decisions.map((d) => d.action).join(" -> ")}`,
    ];
    return lines.join("\n");
  }
}
