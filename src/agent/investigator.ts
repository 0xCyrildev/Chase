import { runAnalysis } from "../commands/analyze.js";
import { triage } from "../triage/index.js";
import { ScanResult } from "./types.js";

export interface InvestigationResult {
  digest: string;
  hypothesis: string;
  verdict: "benign" | "suspicious" | "needs-review";
  reasoning: string;
  tier?: string;
  action?: string;
  score?: number;
}

export async function investigate(
  finding: ScanResult,
  network: "mainnet" | "testnet" | "devnet"
): Promise<InvestigationResult> {
  // 1. Re-analyze for full detail
  let report;
  try {
    report = await runAnalysis(finding.digest, false, true, network);
  } catch (err: any) {
    return {
      digest: finding.digest,
      hypothesis: "analysis failed",
      verdict: "needs-review",
      reasoning: `could not re-analyze: ${err?.message ?? err}`,
    };
  }

  // 2. Run triage on this digest
  let tier: string | undefined;
  let action: string | undefined;
  let score: number | undefined;

  try {
    const tr = await triage([finding.digest], { network, minTier: "P3" });
    const top = tr.findings[0];
    if (top) {
      tier = top.tier;
      action = top.nextAction;
      score = top.score;
    }
  } catch {
    // triage failure non-fatal
  }

  // 3. Deterministic hypothesis based on tier and violations
  const hasHighSeverity = report.violations.some((v) => v.severity === "high");
  const hasCritical = report.violations.some((v) => v.severity === "critical");

  let verdict: InvestigationResult["verdict"] = "needs-review";
  let hypothesis = "unclassified";
  let reasoning = "";

  if (tier === "NOISE" || tier === "P3") {
    verdict = "benign";
    hypothesis = "low-priority pattern";
    reasoning = `Triage assigned tier ${tier}. Violations match documented heuristics or benign patterns.`;
  } else if (tier === "P0" || hasCritical) {
    verdict = "suspicious";
    hypothesis = "high-confidence pattern";
    reasoning = `Triage assigned tier ${tier ?? "P0"}. Multiple high-confidence signals or a critical severity violation.`;
  } else if (tier === "P1" || hasHighSeverity) {
    verdict = "suspicious";
    hypothesis = "high-severity pattern";
    reasoning = `Triage assigned tier ${tier ?? "P1"}. At least one high-severity violation present.`;
  } else {
    verdict = "needs-review";
    hypothesis = "ambiguous pattern";
    reasoning = `Triage tier ${tier ?? "unknown"}. Manual review recommended.`;
  }

  return {
    digest: finding.digest,
    hypothesis,
    verdict,
    reasoning,
    tier,
    action,
    score,
  };
}
