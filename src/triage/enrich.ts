import { AnalysisReport, Violation } from "../lib/types.js";
import { EnrichedViolation } from "./types.js";
import { findBenignMatch } from "./benign.js";
import { loadHistory, countSignature } from "./history.js";

export async function enrich(report: AnalysisReport): Promise<EnrichedViolation[]> {
  const history = loadHistory();
  const enriched: EnrichedViolation[] = [];

  for (const violation of report.violations) {
    const corroborating = report.violations.filter(
      (v) =>
        v !== violation &&
        v.type !== violation.type &&
        !isExpectedOverlap(violation.type, v.type)
    );

    const benignMatch = findBenignMatch(violation);
    const historyCount = countSignature(history, violation);

    enriched.push({
      digest: report.digest,
      network: report.network,
      sender: report.sender,
      violation,
      corroborating,
      benignMatch,
      historyCount,
      txSuccess: report.success,
      txStats: report.stats,
    });
  }

  return enriched;
}

function isExpectedOverlap(a: string, b: string): boolean {
  const pairs: [string, string][] = [
    ["CAPABILITY_TRANSFER", "UNEXPECTED_TRANSFER"],
    ["ADDRESS_OUTFLOW", "REENTRANCY_PATTERN"],
  ];
  return pairs.some(([x, y]) => (a === x && b === y) || (a === y && b === x));
}
