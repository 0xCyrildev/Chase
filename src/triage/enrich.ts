import { AnalysisReport, Violation } from "../lib/types.js";
import { allInvariants } from "../invariants/index.js";
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
    // A report-only shape never raises another finding's priority, in either direction.
    if (REPORT_ONLY_TYPES.has(v.type)) continue;
    if (!byType.has(v.type)) byType.set(v.type, v);
  }

  return [...byType.values()];
}

/**
 * Pairs that describe the *same construct*, so they are one opinion and must not corroborate each
 * other. Data rather than a function body because the test suite reads it: a typo here silently
 * re-enables the corroboration inflation this table exists to prevent.
 *
 * The measured history behind each pair:
 * - A flash swap is `borrow -> action -> repay` (FLASH_LOAN_SHAPED), calls one pool module
 *   repeatedly (REPEATED_MODULE_CALLS), and its own sequential entry/exit looks like re-entry
 *   (REENTRANCY_PATTERN). Over 308 live mainnet transactions the only findings that reached P2 were
 *   Cetus flash swaps scoring +25 from exactly this trio — 8 P2s from 2 transactions.
 * - TreasuryCap transfers legitimately surface as unexpected transfers.
 * - An address-scoped outflow on a shared-object swap is the same balance-scoping artifact as a
 *   composition pattern in the same PTB, and COIN_NET_IMBALANCE is that same array summed instead
 *   of read per address. Adding the summed view alongside the per-address one moved 4 transactions
 *   from P3 to P2 before this table was widened to cover the whole swap-shape cluster.
 *
 * What is deliberately NOT here: the dynamic-field types. A field appearing or vanishing is not the
 * same construct as a routing pattern — it is simply too common to be an opinion. Those declare
 * `corroborates: false` instead, which is the honest mechanism; pairing a type against four others
 * to mute it would be using "same construct" to mean "I'm noisy".
 */
export const EXPECTED_OVERLAP: [string, string][] = [
  ["CAPABILITY_TRANSFER", "UNEXPECTED_TRANSFER"],
  ["ADDRESS_OUTFLOW", "REENTRANCY_PATTERN"],
  ["COIN_NET_IMBALANCE", "ADDRESS_OUTFLOW"],
  ["COIN_NET_IMBALANCE", "REENTRANCY_PATTERN"],
  ["COIN_NET_IMBALANCE", "REPEATED_MODULE_CALLS"],
  ["COIN_NET_IMBALANCE", "FLASH_LOAN_SHAPED"],
  // 16 transactions in the corpus both add and remove a field; teardown-and-replace is one
  // construct, and create+delete must not corroborate each other.
  ["DYNAMIC_FIELD_CREATED", "DYNAMIC_FIELD_DELETED"],
  // The same object change seen as "who owns it now" and as "nobody announced it". One event.
  ["UNANNOUNCED_OBJECT_CHANGE", "UNEXPECTED_TRANSFER"],
  ["FLASH_LOAN_SHAPED", "REPEATED_MODULE_CALLS"],
  ["FLASH_LOAN_SHAPED", "REENTRANCY_PATTERN"],
  ["REENTRANCY_PATTERN", "REPEATED_MODULE_CALLS"],
];

/**
 * Types that report a shape without claiming it as independent agreement. Built from the detector
 * declarations so there is exactly one place to change, and it is a typechecked one.
 */
export const REPORT_ONLY_TYPES: ReadonlySet<string> = new Set(
  allInvariants.flatMap((c) => c.emits.filter((e) => e.corroborates === false).map((e) => e.type))
);

function isExpectedOverlap(a: string, b: string): boolean {
  return EXPECTED_OVERLAP.some(
    ([x, y]) => (a === x && b === y) || (a === y && b === x)
  );
}
