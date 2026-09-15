import pc from "picocolors";
import { TriagedFinding, TriageReport, Tier, NextAction } from "./types.js";
import { recordViolations } from "./history.js";

const TIER_COLOR: Record<Tier, (s: string) => string> = {
  P0: (s) => pc.bgRed(pc.white(s)),
  P1: pc.red,
  P2: pc.yellow,
  P3: pc.blue,
  NOISE: pc.gray,
};

export function formatReport(
  findings: TriagedFinding[],
  digests: string[]
): TriageReport {
  const allViolations = findings.map((f) => f.violation);
  recordViolations(allViolations);

  const byTier: Record<Tier, number> = { P0: 0, P1: 0, P2: 0, P3: 0, NOISE: 0 };
  const byAction: Record<NextAction, number> = {
    DISMISS: 0,
    MANUAL_REVIEW: 0,
    ESCALATE: 0,
    REPRODUCE: 0,
  };

  for (const f of findings) {
    byTier[f.tier]++;
    if (f.nextAction) byAction[f.nextAction]++;
  }

  const caveats = collectCaveats(findings);

  return {
    generatedAt: new Date().toISOString(),
    digests,
    summary: {
      total: findings.length,
      byTier,
      byAction,
    },
    findings: findings.sort((a, b) => b.score - a.score),
    caveats,
  };
}

function collectCaveats(findings: TriagedFinding[]): string[] {
  const notes = new Set<string>();

  if (findings.some((f) => f.violation.type === "ORACLE_MANIPULATION_SUSPECTED")) {
    notes.add(
      "oracle-pattern is name-based. Legitimate protocols that update their own oracle and act on it will trip it."
    );
  }
  if (findings.some((f) => f.violation.type === "FLASH_LOAN_SHAPED")) {
    notes.add(
      "flash-loan-shaped is name-based. Protocols that match the borrow/action/repay keyword sequence will trip it."
    );
  }
  if (findings.some((f) => f.violation.type === "ADDRESS_OUTFLOW")) {
    notes.add(
      "address-balance-delta fires on shared-object inflows. The recipient side doesn't appear in the gRPC balanceChanges array."
    );
  }
  if (findings.some((f) => f.violation.type === "REPEATED_MODULE_CALLS")) {
    notes.add(
      "repeated-module-calls threshold is tuned to 5. Genuine patterns below 5 go unreported."
    );
  }
  if (findings.some((f) => f.benignMatch)) {
    notes.add(
      "Some findings matched the benign-pattern library and were downweighted. Review src/triage/benign-patterns.json."
    );
  }

  return [...notes];
}

export function printReport(report: TriageReport): void {
  console.log(pc.bold(`\nCHASE - Triage Report`));
  console.log(pc.gray(`Generated: ${report.generatedAt}`));
  console.log(pc.gray(`Digests:   ${report.digests.length}`));
  console.log();

  console.log(pc.bold("Summary"));
  console.log(
    `  ${pc.bgRed(pc.white(" P0 "))} ${report.summary.byTier.P0}   ${pc.red("P1")} ${report.summary.byTier.P1}   ${pc.yellow("P2")} ${report.summary.byTier.P2}   ${pc.blue("P3")} ${report.summary.byTier.P3}   ${pc.gray("NOISE")} ${report.summary.byTier.NOISE}`
  );
  console.log();

  if (report.findings.length === 0) {
    console.log(pc.green("No findings to triage.\n"));
    return;
  }

  console.log(pc.bold("Findings"));
  for (const f of report.findings) {
    const tierLabel = TIER_COLOR[f.tier](` ${f.tier} `);
    console.log(`\n  ${tierLabel} ${pc.bold(f.violation.type)}  ${pc.gray(`score=${f.score}`)}`);
    console.log(pc.gray(`  digest:  ${f.digest}`));
    console.log(pc.gray(`  sender:  ${f.sender.slice(0, 20)}...`));
    console.log(`  ${f.violation.message}`);
    if (f.benignMatch) {
      console.log(pc.green(`  benign match: ${f.benignMatch.pattern}`));
      console.log(pc.gray(`    ${f.benignMatch.reason}`));
    }
    console.log(pc.gray(`  rationale: ${f.rationale}`));
    if (f.nextAction) {
      console.log(`  ${pc.bold("action:")} ${actionColor(f.nextAction)(f.nextAction)}`);
    }
    if (f.explanation) {
      console.log(pc.gray(`  ${f.explanation}`));
    }
  }

  if (report.caveats.length > 0) {
    console.log(pc.bold(`\nCaveats`));
    for (const c of report.caveats) {
      console.log(pc.gray(`  - ${c}`));
    }
  }

  console.log();
}

function actionColor(a: NextAction): (s: string) => string {
  switch (a) {
    case "ESCALATE":
      return pc.red;
    case "MANUAL_REVIEW":
      return pc.yellow;
    case "REPRODUCE":
      return pc.blue;
    default:
      return pc.gray;
  }
}

export function toJson(report: TriageReport): string {
  return JSON.stringify(
    report,
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    2
  );
}
