import { AnalysisReport, Violation } from "../lib/types.js";
import { EnrichedViolation } from "./types.js";
import { findBenignMatch } from "./benign.js";
import { loadHistory, countSignature } from "./history.js";

export async function enrich(report: AnalysisReport): Promise<EnrichedViolation[]> {
  const history = loadHistory(report.network);
  const enriched: EnrichedViolation[] = [];

  for (const violation of report.violations) {
    // Corroboration means independent detectors agreeing, not volume. Two rows from the same
    // detector (e.g. one ADDRESS_OUTFLOW per coin moved) are one opinion, so the list is
    // collapsed to one representative per distinct violation type. Scoring must never be able
    // to escalate a finding because a single noisy detector emitted a lot of rows.
    const corroborating = distinctDetectors(report.violations, violation);

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

function distinctDetectors(
  all: readonly Violation[],
  subject: Violation
): Violation[] {
  const byType = new Map<string, Violation>();

  for (const v of all) {
    if (v === subject) continue;
    if (v.type === subject.type) continue;
    if (isExpectedOverlap(subject.type, v.type)) continue;
    if (!byType.has(v.type)) byType.set(v.type, v);
  }

  return [...byType.values()];
}

function isExpectedOverlap(a: string, b: string): boolean {
  const pairs: [string, string][] = [
    ["CAPABILITY_TRANSFER", "UNEXPECTED_TRANSFER"],
    ["ADDRESS_OUTFLOW", "REENTRANCY_PATTERN"],
  ];
  return pairs.some(([x, y]) => (a === x && b === y) || (a === y && b === x));
}
