import pc from "picocolors";
import { AnalysisReport, Severity } from "./types.js";

const sevColor: Record<Severity, (s: string) => string> = {
  low: pc.blue,
  medium: pc.yellow,
  high: pc.red,
  critical: (s: string) => pc.bgRed(pc.white(s)),
};

export function printReport(report: AnalysisReport): void {
  console.log(pc.bold(`\n🕵  CHASE — Transaction Analysis`));
  console.log(pc.gray(`Digest:  ${report.digest}`));
  console.log(pc.gray(`Network: ${report.network}`));
  console.log(pc.gray(`Sender:  ${report.sender}`));
  console.log(pc.gray(`Time:    ${report.timestamp}`));
  console.log(
    pc.gray(
      `Stats:   ${report.stats.ptbCommands} cmds | ${report.stats.balanceChanges} balance changes | ` +
        `${report.stats.objectChanges} object changes | ${report.stats.events} events`
    )
  );

  if (report.violations.length === 0) {
    console.log(pc.green(`\n✓ No violations detected.\n`));
    return;
  }

  console.log(pc.bold(`\n⚠  ${report.violations.length} violation(s) detected:\n`));
  for (const v of report.violations) {
    const color = sevColor[v.severity];
    console.log(color(`  [${v.severity.toUpperCase()}] ${v.type}`));
    console.log(pc.gray(`    ${v.message}`));
    if (v.evidence) {
      console.log(pc.gray(`    evidence: ${JSON.stringify(v.evidence)}`));
    }
    console.log();
  }
}

export function toJson(report: AnalysisReport): string {
  return JSON.stringify(
    report,
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    2
  );
}
