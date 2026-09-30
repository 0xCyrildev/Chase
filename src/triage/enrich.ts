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

/**
 * Corroboration means independent detectors agreeing. These pairs describe the *same underlying
 * construct*, so agreement between them is one opinion counted twice:
 *
 * - A flash swap is `borrow → action → repay` (FLASH_LOAN_SHAPED), it calls one pool module
 *   repeatedly (REPEATED_MODULE_CALLS), and its own sequential entry/exit looks like re-entry
 *   (REENTRANCY_PATTERN). Measured on 308 live mainnet transactions, the only two findings that
 *   reached P2 were Cetus flash swaps scoring +25 corroboration from exactly this trio — 8 P2s from
 *   2 transactions, none of it independent.
 * - TreasuryCap transfers legitimately surface as unexpected transfers (the pre-existing pair).
 * - Address outflow on a shared-object swap is the same balance-scoping artifact as a composition
 *   pattern in the same PTB (the pre-existing pair).
 *
 * A real flash-loan exploit still stands on FLASH_LOAN_SHAPED alone (base 30, −5 name-based → P3)
 * and keeps any genuinely orthogonal signal: CAPABILITY_TRANSFER, MUTABLE_REFERENCE_RETURNED,
 * ORACLE_MANIPULATION_SUSPECTED and UNEXPECTED_TRANSFER are not in this list.
 */
/**
 * Pairs that describe the *same construct*, so they are one opinion and must not corroborate each
 * other. Data rather than a function body because the test suite reads it: a typo here silently
 * re-enables the corroboration inflation this table exists to prevent.
 */
export const EXPECTED_OVERLAP: [string, string][] = [
  ["CAPABILITY_TRANSFER", "UNEXPECTED_TRANSFER"],
  ["ADDRESS_OUTFLOW", "REENTRANCY_PATTERN"],
  // The same balanceChanges array read two ways: per address, and summed. Not two opinions.
  ["COIN_NET_IMBALANCE", "ADDRESS_OUTFLOW"],
  // Measured, not assumed: shipping COIN_NET_IMBALANCE with only the pair above moved 4
  // transactions from P3 to P2 on the 6,502-trace corpus, because it corroborated the very
  // shape that produces it — a swap routes through pool modules repeatedly (REPEATED_MODULE_CALLS,
  // REENTRANCY_PATTERN, FLASH_LOAN_SHAPED) while value crosses into a pool's internal balance.
  // One swap shape, five ways of noticing it.
  ["COIN_NET_IMBALANCE", "REENTRANCY_PATTERN"],
  ["COIN_NET_IMBALANCE", "REPEATED_MODULE_CALLS"],
  ["COIN_NET_IMBALANCE", "FLASH_LOAN_SHAPED"],
  ["FLASH_LOAN_SHAPED", "REPEATED_MODULE_CALLS"],
  ["FLASH_LOAN_SHAPED", "REENTRANCY_PATTERN"],
  ["REENTRANCY_PATTERN", "REPEATED_MODULE_CALLS"],
];

function isExpectedOverlap(a: string, b: string): boolean {
  return EXPECTED_OVERLAP.some(
    ([x, y]) => (a === x && b === y) || (a === y && b === x)
  );
}
