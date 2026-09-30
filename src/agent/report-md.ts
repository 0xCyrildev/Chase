import { AgentReport, ScanCoverage } from "./types.js";
import { TriagedScanResult } from "./scout.js";
import { InvestigationEvidence, InvestigationSource } from "./investigator.js";

/**
 * Which layer formed a reading. A rules table and a model's judgement are not the same statement,
 * and a reader skimming tiers must never have to guess which one they are looking at.
 */
export function investigationProvenance(inv?: {
  source?: InvestigationSource;
  model?: string;
}): string {
  switch (inv?.source) {
    case "model":
      return inv.model ? ` (read by ${inv.model})` : "";
    case "rules":
      return " (rules layer, not a model)";
    case "stub":
      return " (stub response, not a judgement)";
    case "fallback":
    case undefined:
      return " [DEGRADED: not a model reading]";
  }
}

/** What the investigator looked at, in one line, so a verdict can be checked rather than trusted. */
export function evidenceLine(e?: InvestigationEvidence): string | null {
  if (!e) return null;
  if (e.commandCount === 0) {
    return e.notes[0] ? `read nothing: ${e.notes[0]}` : "read nothing: no programmable commands";
  }
  const bits = [`${e.commandCount} cmds`, `${e.packages.length} pkgs`];
  if (e.packages[0]) bits.push(`top ${e.packages[0].package} ×${e.packages[0].calls}`);
  bits.push(e.success ? "succeeded" : "reverted");
  if (e.movements[0]) bits.push(`movement ${e.movements[0]}`);
  if (e.transfers.length) bits.push(`${e.transfers.length} transfer(s)`);
  const line = `read: ${bits.join(", ")}`;
  const signals = e.signals.map(
    (s) =>
      `${s.type}${s.count > 1 ? `×${s.count}` : ""} [${s.matched.length ? s.matched.join(", ") : "no names recorded"}]`
  );
  return signals.length > 0 ? `${line} | ${signals.join("; ")}` : line;
}

export function coverageSpan(c: ScanCoverage): number | null {
  if (!c.startCheckpoint || !c.endCheckpoint) return null;
  return Number(BigInt(c.endCheckpoint) - BigInt(c.startCheckpoint) + 1n);
}

export function coverageCaveat(c: ScanCoverage): string {
  // A dry-run, or a budget that stopped before the first pass, produces 0 passes and an empty
  // coverage object. Calling that "complete — every listed transaction reached" is true only in the
  // vacuous sense that it listed nothing, and it reads to a reviewer as a clean sweep.
  if (c.passes === 0) {
    return "NO SCAN RAN: 0 passes completed (dry-run, or the budget stopped before the first pass); this says nothing about the target";
  }

  const problems: string[] = [];
  if (!c.complete) problems.push("a listing stopped before the checkpoint bound");
  if (c.txsErrored > 0)
    problems.push(
      `${c.txsErrored} transactions failed to analyze on ${c.network ?? "the mandate's network"}` +
        (c.txsErrored === c.txsListed && c.txsListed > 0
          ? " (every listed digest failed, which is what a list spanning two networks looks like)"
          : "")
    );

  const unreached =
    c.txsListed -
    c.txsAnalyzed -
    c.txsTargetMissed -
    c.txsSkipped -
    c.txsErrored;
  if (unreached > 0) problems.push(`${unreached} of ${c.txsListed} listed txs not reached`);

  if (problems.length === 0) {
    if (c.checkpointsScanned === 0) {
      return "complete: every named transaction reached (no checkpoint sweep was performed)";
    }
    return "complete: every listed transaction reached, to the checkpoint bound";
  }
  return `INCOMPLETE: ${problems.join("; ")}`;
}

export function toMarkdown(report: AgentReport): string {
  const lines: string[] = [];

  lines.push(`# Chase Hunt Report`);
  lines.push(``);
  lines.push(`**Network:** ${report.coverage?.network ?? "unknown"}`);
  lines.push(`**Target:** \`${report.mandate.target}\``);
  lines.push(`**Goal:** ${report.mandate.goal}`);
  const c = report.coverage;
  lines.push(
    report.mandate.txs?.length
      ? `**Scope:** ${report.mandate.txs.length} named transaction(s), 1 pass (no checkpoint sweep)`
      : `**Scope:** ${report.mandate.checkpoints} checkpoints per pass × ${c.passes} passes`
  );
  const span = coverageSpan(c);
  const counted = [`${c.txsListed} txs listed`, `${c.txsAnalyzed} analyzed`];
  if (c.txsTargetMissed > 0) counted.push(`${c.txsTargetMissed} did not call the target`);
  if (c.txsSkipped > 0) counted.push(`${c.txsSkipped} system txs skipped`);
  if (c.txsCarried > 0) counted.push(`${c.txsCarried} already seen`);
  if (c.txsErrored > 0) counted.push(`${c.txsErrored} failed`);
  lines.push(
    `**Covered:** seq ${c.startCheckpoint ?? "n/a"}–${c.endCheckpoint ?? "n/a"} (${span ?? 0} checkpoints wide) · ${counted.join(" · ")}`
  );
  lines.push(`**Coverage:** ${coverageCaveat(c)}`);
  lines.push(`**Started:** ${report.startedAt}`);
  lines.push(`**Duration:** ${report.usage.elapsedMs}ms`);
  lines.push(``);

  lines.push(`## Usage`);
  lines.push(``);
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| RPC calls | ${report.usage.rpcCalls} |`);
  lines.push(`| LLM calls | ${report.usage.llmCalls} |`);
  lines.push(`| Tokens | ${report.usage.llmTokens} |`);
  lines.push(``);

  lines.push(`## Decisions`);
  lines.push(``);
  if (report.decisions.length === 0) {
    lines.push(`No decisions recorded.`);
  } else {
    for (const d of report.decisions) {
      lines.push(
        `- **${d.action}${d.degraded ? " [DEGRADED: not a model decision]" : ""}**: ${d.reason}`
      );
    }
  }
  lines.push(``);

  lines.push(`## Findings (${report.findings.length})`);
  lines.push(``);

  if (report.findings.length === 0) {
    lines.push(`No findings.`);
  } else {
    const triaged = report.findings as TriagedScanResult[];
    for (const f of triaged) {
      lines.push(`### \`${f.digest}\``);
      lines.push(``);
      lines.push(`- **Checkpoint:** ${f.checkpoint}`);
      if (f.tier) lines.push(`- **Tier:** ${f.tier}`);
      if (f.action) lines.push(`- **Recommended action:** ${f.action}`);
      if (typeof f.score === "number") lines.push(`- **Score:** ${f.score}`);
      if (f.tierError) lines.push(`- **Triage problem:** ${f.tierError}`);
      if (f.investigationError) lines.push(`- **Investigation problem:** ${f.investigationError}`);
      if (f.investigation) {
        lines.push(
          `- **Investigator:** ${f.investigation.verdict}. ${f.investigation.hypothesis}${investigationProvenance(f.investigation)}`
        );
        const evidence = evidenceLine(f.investigation.evidence);
        if (evidence) lines.push(`  - ${evidence}`);
        if (f.investigation.reasoning) {
          lines.push(`  - ${f.investigation.reasoning}`);
        }
      }
      lines.push(``);
      for (const v of f.violations) {
        lines.push(`- **${v.severity.toUpperCase()}** ${v.type}: ${v.message}`);
      }
      lines.push(``);
    }
  }

  lines.push(`## Summary`);
  lines.push(``);
  if (report.summaryDegraded) {
    lines.push(`_(generated by the fallback path, not by the configured model)_`);
    lines.push(``);
  }
  lines.push(report.summary);
  lines.push(``);

  return lines.join("\n");
}
